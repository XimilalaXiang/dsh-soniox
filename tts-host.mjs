// The TTS half: two authenticated Fetch routes plus one agent tool.
//
// DSH has no speech-synthesis service to register into, so this module builds
// the surface the way the harness itself builds feature-owned downloads
// (`ctx.connection.fetch.register`, the same seam behind `/api/file`):
//
//   POST /api/dsh-soniox/speak      text -> { id, url, characters, cached }
//   GET  /api/dsh-soniox/audio?id=  cached audio bytes for <audio src=...>
//   tool `speak`                    text -> a file on disk (CLI/headless path)
//
// The browser half (a read-aloud button) lives in client.mjs and needs no
// protocol work: it points an <audio> element at the returned url.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { SpeechCache, speechId } from './cache.mjs';
import { importHostPackage } from './runtime.mjs';
import { resolveApiKey } from './secrets.mjs';
import { isSpeakable, speakableText } from './speakable.mjs';
import { SonioxTts, SonioxTtsError, TTS_FORMATS, formatInfo } from './tts.mjs';

export const SPEAK_PATH = '/api/dsh-soniox/speak';
export const AUDIO_PATH = '/api/dsh-soniox/audio';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const ID_PATTERN = /^[a-f0-9]{32}$/;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/** Deterministic audio id for one normalized request. */
export function requestShape(config, request) {
  return {
    text: request.text,
    model: request.model ?? config.model,
    voice: request.voice ?? config.voice,
    language: request.language ?? config.language,
    format: request.format ?? config.format,
    sampleRate: config.sampleRate ?? null,
    bitrate: config.bitrate ?? null,
  };
}

/**
 * Prepare (or reuse) audio for one text and report where to fetch it.
 *
 * A cache hit costs nothing and is served from a different route, so repeat
 * playback — pressing the button twice, reopening a session — never reaches
 * Soniox again.
 */
export async function prepareSpeech(config, request, { cache, ctx, signal, createTts } = {}) {
  const raw = typeof request?.text === 'string' ? request.text : '';
  const cleaned = (request?.speakable ?? config.speakable) ? speakableText(raw, { maxChars: config.maxCharacters }) : raw;
  const text = cleaned.trim();
  if (!text) return { status: 422, body: { error: 'nothing to speak' } };
  if (!isSpeakable(text)) return { status: 422, body: { error: 'nothing to speak' } };
  if (text.length > config.maxCharacters) {
    return { status: 413, body: { error: `text is ${text.length} characters; the limit is ${config.maxCharacters}` } };
  }

  const shape = requestShape(config, { ...request, text });
  const id = speechId(shape);
  const cachedMeta = await cache.get(id);
  if (cachedMeta) {
    return {
      status: 200,
      body: {
        id,
        url: `${AUDIO_PATH}?id=${id}`,
        cached: true,
        contentType: cachedMeta.contentType,
        characters: cachedMeta.characters ?? text.length,
        bytes: cachedMeta.bytes,
      },
    };
  }

  const key = await resolveApiKey(config, ctx);
  if (!key) {
    return { status: 503, body: { error: `Soniox API key is unavailable (${config.apiKeyEnv})` } };
  }
  const started = Date.now();
  // `config.url` is null when unset; passing null through would reach fetch as a URL.
  const synthesize = createTts ?? ((apiKey) => new SonioxTts({ key: apiKey, url: config.url ?? undefined }));
  const result = await synthesize(key).synthesize({ ...shape, maxCharacters: config.maxCharacters }, signal);
  await cache.put(id, result.bytes, {
    contentType: result.contentType,
    format: result.format,
    characters: result.characters,
  });
  return {
    status: 200,
    body: {
      id,
      url: `${AUDIO_PATH}?id=${id}`,
      cached: false,
      contentType: result.contentType,
      characters: result.characters,
      bytes: result.bytes.length,
      ms: Date.now() - started,
    },
  };
}

/**
 * The `speak` tool definition.
 *
 * Exported separately from its registration so the spec and its `execute` can be
 * exercised without a Host runtime, and so `defineTool` stays the only Host
 * dependency of this half.
 */
export function speakToolSpec(config, ctx, { cache, createTts } = {}) {
  return {
    name: 'speak',
    description:
      'Render text as speech with Soniox TTS and save it as an audio file. Use it when the user asks for audio, ' +
      'a voice note, or a spoken version of some text. Markdown is normalized to speakable prose by default.',
    parameters: {
      text: { type: 'string', required: true, description: 'The text to speak.' },
      voice: { type: 'string', description: `Soniox voice name. Default: ${config.voice}.` },
      format: {
        type: 'string',
        enum: Object.keys(TTS_FORMATS),
        description: 'Output format. Default: mp3 (smallest and playable everywhere).',
      },
      file: {
        type: 'string',
        description: `File name or absolute path for the audio. Default: a generated name in ${config.dataDir}.`,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true, description: 'Absolute path of the written audio file.' },
          bytes: { type: 'number', required: true },
          characters: { type: 'number', required: true, description: 'Characters sent to Soniox (billed).' },
          contentType: { type: 'string', required: true },
          cached: { type: 'boolean', required: true, description: 'True when the audio already existed locally.' },
        },
      },
    },
    presentCall: (args) => ({ card: 'generic', title: 'Speak', kind: 'other', rawInput: args.text }),
    async execute(args, exec) {
      const format = args.format ?? config.format;
      const { status, body } = await prepareSpeech(
        config,
        { text: args.text, voice: args.voice, format, speakable: config.speakable },
        { cache, ctx, signal: exec?.signal, createTts },
      );
      if (status !== 200) throw new Error(body.error);
      const bytes = await cache.read(body.id);
      if (!bytes) throw new Error('speech audio disappeared from the cache');
      const target = args.file
        ? args.file.startsWith('/')
          ? args.file
          : join(config.dataDir, args.file)
        : join(config.dataDir, `${body.id}.${formatInfo(format).extension}`);
      await mkdir(join(target, '..'), { recursive: true });
      await writeFile(target, bytes);
      return {
        path: target,
        bytes: bytes.length,
        characters: body.characters,
        contentType: body.contentType,
        cached: body.cached,
      };
    },
  };
}

/**
 * Mount the routes and the tool.
 *
 * Both halves are mounted independently: a deployment without the `tools`
 * service (or without a resolvable runtime) still gets the browser surface, and
 * the agent tool simply stays absent.
 */
export function mountTts(ctx, config, deps = {}) {
  const cache = deps.cache ?? new SpeechCache(config.dataDir, { maxBytes: config.cacheMaxBytes });
  const disposers = [];

  const speak = async (request) => {
    let payload;
    try {
      payload = await request.json();
    } catch {
      return json({ error: 'expected a JSON body' }, 400);
    }
    try {
      const { status, body } = await prepareSpeech(config, payload, { cache, ctx, signal: request.signal });
      return json(body, status);
    } catch (error) {
      const message = error instanceof SonioxTtsError ? error.message : `speech synthesis failed (${error?.name ?? 'Error'})`;
      ctx.logger?.warn?.(`[dsh-soniox] ${message}`);
      return json({ error: message }, error instanceof SonioxTtsError ? 502 : 500);
    }
  };

  const audio = async (request) => {
    const id = new URL(request.url).searchParams.get('id') ?? '';
    if (!ID_PATTERN.test(id)) return json({ error: 'invalid id' }, 400);
    const meta = await cache.get(id);
    if (!meta) return json({ error: 'unknown id' }, 404);
    const headers = {
      'content-type': meta.contentType,
      // `no-transform` keeps the carrier from gzipping already-compressed audio.
      'cache-control': 'private, max-age=31536000, immutable, no-transform',
      'x-content-type-options': 'nosniff',
    };
    if (request.method === 'HEAD') return new Response(null, { status: 200, headers });
    const bytes = await cache.read(id);
    if (!bytes) return json({ error: 'unknown id' }, 404);
    return new Response(bytes, { status: 200, headers: { ...headers, 'content-length': String(bytes.length) } });
  };

  if (typeof ctx.connection?.fetch?.register === 'function') {
    ctx.effect(() => {
      const registered = [
        ctx.connection.fetch.register({ path: SPEAK_PATH, methods: ['POST'], requestBody: 'buffered', fetch: speak }),
        ctx.connection.fetch.register({ path: AUDIO_PATH, methods: ['GET', 'HEAD'], requestBody: 'buffered', fetch: audio }),
      ];
      return () => {
        for (const entry of registered) void Promise.resolve(entry).then((dispose) => dispose?.());
      };
    }, 'dsh-soniox: speech routes');
    disposers.push('routes');
  } else {
    ctx.logger?.debug?.('[dsh-soniox] connection.fetch is unavailable; speech routes not mounted');
  }

  const registerTool = deps.registerTool ?? ((tool) => ctx.tools?.register?.(tool));
  if (typeof registerTool === 'function') {
    // Awaited: the tool needs a Host helper that loads asynchronously.
    void (async () => {
      const tools = await importHostPackage('@deepseek-ai/dsh-tools');
      if (!tools?.defineTool) {
        ctx.logger?.debug?.('[dsh-soniox] host tools package is unavailable; the speak tool is not mounted');
        return;
      }
      registerTool(tools.defineTool(speakToolSpec(config, ctx, { cache, createTts: deps.createTts })));
      ctx.logger?.info?.('[dsh-soniox] speak tool registered');
    })();
  }

  return disposers;
}
