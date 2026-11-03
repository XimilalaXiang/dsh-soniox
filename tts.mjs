// Soniox text-to-speech REST client.
//
//   POST https://tts-rt.soniox.com/tts   { model, language, voice, audio_format, text }
//   -> raw audio bytes, Content-Type per audio_format
//
// Notes carried over from hermes-soniox and re-checked against the current API:
//   * the request schema has no `speed` field, so speed is not forwarded and no
//     clamping is needed (the Hermes plugin sent one; the API ignores it);
//   * text length is bounded by Soniox itself, so the bound is enforced here
//     with a clear error instead of a remote 400;
//   * the key travels only in the Authorization header and is stripped from
//     every message this module produces.

/** Soniox TTS endpoint (REST, request/response). */
export const TTS_URL = 'https://tts-rt.soniox.com/tts';

/** Formats the plugin exposes, with the Content-Type Soniox returns for each. */
export const TTS_FORMATS = Object.freeze({
  mp3: { contentType: 'audio/mpeg', extension: 'mp3' },
  wav: { contentType: 'audio/wav', extension: 'wav' },
  opus: { contentType: 'audio/opus', extension: 'opus' },
  flac: { contentType: 'audio/flac', extension: 'flac' },
  aac: { contentType: 'audio/aac', extension: 'aac' },
  pcm_s16le: { contentType: 'audio/pcm', extension: 'pcm' },
});

/** The Soniox per-request text limit; the harness may cap lower. */
export const TTS_MAX_CHARACTERS = 5000;

const MAX_ERROR_CHARS = 300;

/** A Soniox TTS call failed. The message is safe to log. */
export class SonioxTtsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SonioxTtsError';
  }
}

export function formatInfo(format) {
  return TTS_FORMATS[format] ?? TTS_FORMATS.mp3;
}

export class SonioxTts {
  /**
   * @param options.key - SONIOX_API_KEY value.
   * @param [options.url] - endpoint override.
   * @param [options.fetchImpl] - injectable fetch, for tests.
   */
  constructor({ key, url = TTS_URL, fetchImpl = globalThis.fetch } = {}) {
    this.key = typeof key === 'string' ? key.trim() : '';
    this.url = url;
    this.fetchImpl = fetchImpl;
  }

  redact(text) {
    const value = String(text ?? '');
    return this.key ? value.split(this.key).join('***') : value;
  }

  /**
   * Synthesize one utterance.
   * @param request - `{ text, model, voice, language, format, sampleRate?, bitrate? }`.
   * @param signal - caller cancellation.
   * @returns `{ bytes, contentType, format, characters }`.
   */
  async synthesize(request, signal) {
    const text = typeof request?.text === 'string' ? request.text : '';
    if (!text.trim()) throw new SonioxTtsError('Soniox TTS requires non-empty text');
    const maxCharacters = request.maxCharacters ?? TTS_MAX_CHARACTERS;
    if (text.length > maxCharacters) {
      throw new SonioxTtsError(`Soniox TTS text is ${text.length} characters; the limit is ${maxCharacters}`);
    }
    if (!this.key) {
      throw new SonioxTtsError('Soniox API key is unavailable; add SONIOX_API_KEY to $DSH_HOME/.env');
    }
    const format = TTS_FORMATS[request.format] ? request.format : 'mp3';
    const body = {
      model: request.model,
      language: request.language,
      voice: request.voice,
      audio_format: format,
      text,
    };
    if (Number.isSafeInteger(request.sampleRate)) body.sample_rate = request.sampleRate;
    if (Number.isSafeInteger(request.bitrate)) body.bitrate = request.bitrate;

    let response;
    try {
      response = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new SonioxTtsError(`Soniox TTS request failed (${error?.name ?? 'Error'})`);
    }
    if (!response.ok) throw new SonioxTtsError(await this.#httpError(response));
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length === 0) throw new SonioxTtsError('Soniox TTS returned empty audio');
    const info = formatInfo(format);
    // Trust an audio/* header, but not a generic one: a container that says
    // `application/octet-stream` makes `<audio>` refuse to play it, so the
    // requested format is the better answer there.
    const announced = response.headers?.get?.('content-type') ?? '';
    const contentType = announced.startsWith('audio/') ? announced : info.contentType;
    return { bytes, format, contentType, characters: text.length };
  }

  async #httpError(response) {
    let type;
    let message;
    try {
      const parsed = await response.json();
      if (parsed && typeof parsed === 'object') {
        type = parsed.error_type ?? parsed.error_code;
        message = parsed.error_message ?? parsed.message;
      }
    } catch {
      // A body that is not JSON carries no safe detail beyond the status.
    }
    const head = `Soniox TTS failed (HTTP ${response.status}${typeof type === 'string' && type ? `, ${type}` : ''})`;
    const full = typeof message === 'string' && message ? `${head}: ${message}` : head;
    return this.redact(full).slice(0, MAX_ERROR_CHARS);
  }
}
