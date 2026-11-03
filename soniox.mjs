// Minimal Soniox REST client for DeepSeek Harness.
//
// Only the standard library and global fetch are used: no Soniox SDK, so the
// package carries no runtime dependencies and cannot drift from the Host's
// Node version.
//
// Two Soniox products are involved and only one is used here:
//
//   STT (async)  POST/GET https://api.soniox.com/v1/{files,transcriptions}
//   STT (realtime websocket) wss://stt-rt.soniox.com/transcribe-websocket
//
// DSH hands a provider one *complete* recording, and Soniox's own guidance for
// a finished recording is the async file path (the realtime socket gives up
// full-context accuracy and bills stream duration). So this client implements
// upload -> create -> poll -> transcript -> delete, and nothing else.
//
// Safety rules carried over from hermes-soniox:
//   * the key travels only in an Authorization header;
//   * the key is redacted from every error string this module produces;
//   * remote resources are deleted on both success and failure paths.

/** Default Soniox REST origin. */
export const STT_BASE_URL = 'https://api.soniox.com/v1';

/** Longest error text handed back to the Host; Soniox messages can be verbose. */
const MAX_ERROR_CHARS = 300;

/** A Soniox call failed. The message is safe to log: it never contains the key. */
export class SonioxError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SonioxError';
  }
}

/** Soniox exports the transcript as `text` or as a token list; join either. */
export function transcriptText(body) {
  if (!body || typeof body !== 'object') throw new SonioxError('Soniox transcript response was malformed');
  if (typeof body.text === 'string') return body.text.trim();
  const tokens = body.tokens;
  if (Array.isArray(tokens) && tokens.length > 0 && tokens.every((t) => t && typeof t.text === 'string')) {
    return tokens.map((t) => t.text).join('').trim();
  }
  throw new SonioxError('Soniox transcript response was malformed');
}

export class SonioxClient {
  /**
   * @param options.key - SONIOX_API_KEY value.
   * @param [options.baseUrl] - REST origin override (self-hosted/regional).
   * @param [options.fetchImpl] - injectable fetch, for tests.
   */
  constructor({ key, baseUrl = STT_BASE_URL, fetchImpl = globalThis.fetch } = {}) {
    this.key = typeof key === 'string' ? key.trim() : '';
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.fetchImpl = fetchImpl;
  }

  /** Remove the API key from any text that may reach a log or the UI. */
  redact(text) {
    const value = String(text ?? '');
    return this.key ? value.split(this.key).join('***') : value;
  }

  #headers(extra = {}) {
    return { Authorization: `Bearer ${this.key}`, ...extra };
  }

  async #request(op, path, { method = 'GET', headers, body, signal } = {}) {
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: this.#headers(headers),
        body,
        signal,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new SonioxError(`Soniox ${op} request failed (${error?.name ?? 'Error'})`);
    }
    if (!response.ok) throw new SonioxError(await this.#httpError(op, response));
    return response;
  }

  async #httpError(op, response) {
    let type;
    let message;
    try {
      const parsed = await response.json();
      if (parsed && typeof parsed === 'object') {
        type = parsed.error_type;
        message = parsed.error_message ?? parsed.message;
      }
    } catch {
      // A non-JSON body carries no safe detail beyond the status code.
    }
    const head = `Soniox ${op} failed (HTTP ${response.status}${typeof type === 'string' && type ? `, ${type}` : ''})`;
    const full = typeof message === 'string' && message ? `${head}: ${message}` : head;
    return this.redact(full).slice(0, MAX_ERROR_CHARS);
  }

  async #json(op, response) {
    let body;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    if (!body || typeof body !== 'object') throw new SonioxError(`Soniox ${op} returned a malformed response`);
    return body;
  }

  static #requireId(op, body) {
    const id = body?.id;
    if (typeof id !== 'string' || !id) throw new SonioxError(`Soniox ${op} returned a malformed response (no id)`);
    return id;
  }

  /**
   * Upload one recording for async transcription.
   * @param audio - canonical WAV bytes.
   * @param [filename] - display name Soniox stores with the file.
   * @param signal - caller cancellation.
   * @returns uploaded file id.
   */
  async uploadFile(audio, filename = 'audio.wav', signal) {
    const form = new FormData();
    form.append('file', new Blob([audio]), filename);
    const response = await this.#request('file upload', '/files', { method: 'POST', body: form, signal });
    return SonioxClient.#requireId('file upload', await this.#json('file upload', response));
  }

  /**
   * Create one transcription job.
   * @param body - `{ file_id, model, language_hints?, context? }`.
   * @returns transcription id.
   */
  async createTranscription(body, signal) {
    const response = await this.#request('transcription create', '/transcriptions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    return SonioxClient.#requireId('transcription create', await this.#json('transcription create', response));
  }

  /**
   * Poll until the job completes.
   * Non-terminal statuses keep polling so the wait stays bounded by the timeout
   * instead of failing on an unexpected value.
   */
  async waitForCompletion(id, { signal, timeoutMs = 60_000, initialDelayMs = 300, maxDelayMs = 3_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let delay = initialDelayMs;
    for (;;) {
      const response = await this.#request('transcription status', `/transcriptions/${id}`, { signal });
      const body = await this.#json('transcription status', response);
      if (body.status === 'completed') return;
      if (body.status === 'error') {
        const detail = [body.error_type, body.error_message].filter((v) => typeof v === 'string' && v).join(': ');
        throw new SonioxError(
          this.redact(`Soniox transcription failed${detail ? ` (${detail})` : ''}`).slice(0, MAX_ERROR_CHARS),
        );
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new SonioxError(`Soniox transcription timed out after ${timeoutMs}ms`);
      await sleep(Math.min(delay, remaining), signal);
      delay = Math.min(delay * 1.5, maxDelayMs);
    }
  }

  /** Final transcript for a completed job. */
  async getTranscript(id, signal) {
    const response = await this.#request('transcript fetch', `/transcriptions/${id}/transcript`, { signal });
    return transcriptText(await this.#json('transcript fetch', response));
  }

  async deleteTranscription(id, signal) {
    await this.#request('transcription delete', `/transcriptions/${id}`, { method: 'DELETE', signal });
  }

  async deleteFile(id, signal) {
    await this.#request('file delete', `/files/${id}`, { method: 'DELETE', signal });
  }

  /**
   * Delete whatever this call uploaded, never throwing.
   *
   * Cleanup must survive cancellation: an aborted `signal` is not passed on, so
   * a cancelled recording still stops billing for the uploaded file.
   */
  async cleanup({ transcriptionId, fileId, onError } = {}) {
    for (const [label, run] of [
      ['transcription', transcriptionId && ((id) => this.deleteTranscription(id))],
      ['file', fileId && ((id) => this.deleteFile(id))],
    ]) {
      if (!run) continue;
      try {
        await run(label === 'transcription' ? transcriptionId : fileId);
      } catch (error) {
        onError?.(`Soniox ${label} cleanup failed: ${this.redact(error?.message ?? error)}`);
      }
    }
  }
}

/** Abortable sleep; resolves early when the caller cancels. */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(signal.reason);
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Duration in seconds of a canonical 16 kHz mono PCM16 WAV, or null.
 *
 * Walks the RIFF chunk list rather than assuming a 44-byte header: encoders
 * (ffmpeg, browsers) insert `LIST`/`fact` chunks before `data`, which would
 * make a fixed offset read a garbage length.
 */
export function wavSeconds(audio) {
  if (!audio || audio.length < 12) return null;
  const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength);
  const tag = (at) => String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
  let format = null;
  let dataBytes = 0;
  let offset = 12;
  while (offset + 8 <= audio.length) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ' && body + 16 <= audio.length) {
      format = {
        encoding: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      // A streamed WAV may declare 0xFFFFFFFF; clamp to what actually arrived.
      dataBytes = Math.min(size, audio.length - body);
      break;
    }
    // Chunks are word-aligned.
    offset = body + size + (size % 2);
  }
  if (!format || format.encoding !== 1 || format.channels !== 1) return null;
  if (format.sampleRate !== 16_000 || format.bits !== 16 || dataBytes <= 0) return null;
  return dataBytes / (16_000 * 2);
}
