// dsh-soniox — native BYOK Soniox speech for DeepSeek Harness.
//
// Two halves, because the harness offers two different kinds of seam:
//
//   * STT registers a real provider (id `soniox`) into `ctx.speechToText`
//     (@deepseek-ai/dsh-experimental-speech-to-text), so the Host microphone UI
//     lists it beside any local recognizer.
//   * TTS has no service to register into — the voice-input subsystem states
//     that "streaming recognition and speech synthesis have no service
//     methods" — so it mounts its own authenticated Fetch routes plus an agent
//     tool (see tts-host.mjs) and a browser surface (client.mjs).
//
// The STT provider receives one complete canonical 16 kHz mono PCM16 WAV and
// does no audio conversion: Soniox's file API auto-detects WAV headers.
import { homedir } from 'node:os';
import { join } from 'node:path';

import { LANGUAGES, languageHints, normalizeLanguage } from './languages.mjs';
import { resolveApiKey as resolveKey } from './secrets.mjs';
import { SonioxClient, SonioxError, wavSeconds } from './soniox.mjs';
import { TTS_FORMATS, TTS_MAX_CHARACTERS } from './tts.mjs';
import { mountTts } from './tts-host.mjs';

export { resolveApiKey } from './secrets.mjs';

export const name = 'dsh-soniox';

/** The voice-input service must exist before this provider can register. */
export const inject = ['speechToText'];

const DEFAULT_MODEL = 'stt-async-v5';
const DEFAULT_API_KEY_ENV = 'SONIOX_API_KEY';
const DEFAULT_POLL_TIMEOUT_MS = 60_000;
const DEFAULT_PROVIDER_ID = 'soniox';

function invalid(message) {
  const error = new TypeError(message);
  error.code = 'soniox-provider-invalid';
  return error;
}

function requireString(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw invalid(`${field} must be a non-empty string`);
  return value.trim();
}

function optionalString(value, field) {
  if (value === undefined || value === null || value === '') return null;
  return requireString(value, field);
}

/** Advertised languages; a subset of Soniox's support that DSH can validate. */
function languages(value) {
  if (value === undefined) return LANGUAGES;
  if (!Array.isArray(value) || value.length === 0) throw invalid('languages must be a non-empty array');
  const list = [];
  for (const entry of value) {
    const code = normalizeLanguage(requireString(entry, 'languages'));
    if (code && !list.includes(code)) list.push(code);
  }
  // `auto` is DSH's "detect it yourself" value and must always be offered,
  // because it is the registry default when no language has been saved yet.
  return Object.freeze(list.includes('auto') ? list : ['auto', ...list]);
}

function positiveInt(value, field) {
  if (value === undefined) return null;
  if (!Number.isSafeInteger(value) || value <= 0) throw invalid(`${field} must be a positive integer`);
  return value;
}

/**
 * Validate one provider entry once, so a bad config fails at load time rather
 * than on the user's first recording.
 */
export function normalizeProvider(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('provider entry must be an object');
  return Object.freeze({
    id: requireString(input.id ?? DEFAULT_PROVIDER_ID, 'id'),
    displayName: typeof input.name === 'string' && input.name.trim() ? input.name.trim() : 'Soniox',
    languages: languages(input.languages),
    model: requireString(input.model ?? DEFAULT_MODEL, 'model'),
    // A comma-separated string is accepted because that is how hermes-soniox
    // spelled the same setting, so the two configs read alike.
    hints: Object.freeze(
      languageHints(null, input.languageHints ?? input.language ?? []),
    ),
    contextText: optionalString(input.contextText, 'contextText'),
    baseUrl: optionalString(input.baseUrl, 'baseUrl'),
    apiKeyEnv: typeof input.apiKeyEnv === 'string' && input.apiKeyEnv.trim() ? input.apiKeyEnv.trim() : DEFAULT_API_KEY_ENV,
    apiKeyRef: optionalString(input.apiKeyRef, 'apiKeyRef'),
    apiKeyFile: optionalString(input.apiKeyFile, 'apiKeyFile'),
    pollTimeoutMs: positiveInt(input.pollTimeoutMs, 'pollTimeoutMs') ?? DEFAULT_POLL_TIMEOUT_MS,
  });
}

const DEFAULT_TTS_MODEL = 'tts-rt-v2';
const DEFAULT_TTS_VOICE = 'Meilin';
const DEFAULT_TTS_LANGUAGE = 'zh';
const DEFAULT_TTS_FORMAT = 'mp3';
const DEFAULT_CACHE_BYTES = 64 * 1024 * 1024;

function ttsLanguage(value) {
  const code = normalizeLanguage(value ?? DEFAULT_TTS_LANGUAGE);
  if (!code) throw invalid('tts.language must be a language code');
  return code;
}

function ttsFormat(value) {
  if (value === undefined) return DEFAULT_TTS_FORMAT;
  const format = requireString(value, 'tts.format');
  // Unknown formats are refused rather than silently degraded: the caller asked
  // for a container, and quietly returning mp3 is worse than failing.
  if (!TTS_FORMATS[format]) {
    throw invalid(`tts.format must be one of: ${Object.keys(TTS_FORMATS).join(', ')}`);
  }
  return format;
}

/**
 * TTS settings. Absent means "mount the defaults", because the plugin is
 * installed precisely to get speech out; `enabled: false` turns it off.
 */
export function normalizeTts(input = {}, provider = undefined) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('tts must be an object');
  const dataDir = optionalString(input.dataDir, 'tts.dataDir')
    ?? join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-soniox');
  const maxCharacters = positiveInt(input.maxCharacters, 'tts.maxCharacters') ?? TTS_MAX_CHARACTERS;
  return Object.freeze({
    enabled: input.enabled !== false,
    model: requireString(input.model ?? DEFAULT_TTS_MODEL, 'tts.model'),
    voice: requireString(input.voice ?? DEFAULT_TTS_VOICE, 'tts.voice'),
    language: ttsLanguage(input.language),
    format: ttsFormat(input.format),
    sampleRate: positiveInt(input.sampleRate, 'tts.sampleRate'),
    bitrate: positiveInt(input.bitrate, 'tts.bitrate'),
    url: optionalString(input.url, 'tts.url'),
    maxCharacters,
    dataDir,
    cacheMaxBytes: positiveInt(input.cacheMaxBytes, 'tts.cacheMaxBytes') ?? DEFAULT_CACHE_BYTES,
    speakable: input.speakable !== false,
    autoSpeak: input.autoSpeak === true,
    apiKeyEnv: typeof input.apiKeyEnv === 'string' && input.apiKeyEnv.trim()
      ? input.apiKeyEnv.trim()
      : provider?.apiKeyEnv ?? DEFAULT_API_KEY_ENV,
    apiKeyRef: optionalString(input.apiKeyRef, 'tts.apiKeyRef') ?? provider?.apiKeyRef ?? null,
    apiKeyFile: optionalString(input.apiKeyFile, 'tts.apiKeyFile') ?? provider?.apiKeyFile ?? null,
  });
}

/** `providers: [...]` registers several recognizers; a flat config one. */
export function normalizeConfig(config = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw invalid('config must be an object');
  const tts = normalizeTts(config.tts ?? {});
  if (config.providers !== undefined) {
    if (!Array.isArray(config.providers) || config.providers.length === 0) {
      throw invalid('providers must be a non-empty array');
    }
    const providers = config.providers.map((entry) => normalizeProvider(entry));
    if (new Set(providers.map((entry) => entry.id)).size !== providers.length) {
      throw invalid('provider ids must be unique');
    }
    return Object.freeze({ providers: Object.freeze(providers), tts });
  }
  return Object.freeze({ providers: Object.freeze([normalizeProvider(config)]), tts });
}

/**
 * Build the provider object handed to `ctx.speechToText.register()`.
 * @param options - one normalized provider entry.
 * @param ctx - Host context, used only to reach the credentials service.
 * @param [deps] - injectable client factory and clock, for tests.
 */
export function createProvider(options, ctx, deps = {}) {
  const makeClient = deps.createClient ?? ((key) => new SonioxClient({ key, baseUrl: options.baseUrl ?? undefined }));
  const now = deps.now ?? (() => process.hrtime.bigint());
  return {
    info: {
      id: options.id,
      name: options.displayName,
      // Audio leaves the machine: the Host UI marks cloud providers as such.
      location: 'cloud',
      languages: options.languages ?? LANGUAGES,
    },
    async transcribe(input, signal) {
      const started = now();
      if (!input || !(input.audio instanceof Uint8Array) || input.audio.length === 0) {
        throw new SonioxError('Soniox transcription requires a non-empty recording');
      }
      const key = await resolveKey(options, ctx);
      if (!key) {
        throw new SonioxError(
          `Soniox API key is unavailable (${options.apiKeyEnv}); add it to $DSH_HOME/.env or the Host credential store`,
        );
      }
      const client = makeClient(key);
      const hints = languageHints(input.language, options.hints);
      let fileId;
      let transcriptionId;
      try {
        fileId = await client.uploadFile(input.audio, 'audio.wav', signal);
        transcriptionId = await client.createTranscription(
          {
            file_id: fileId,
            model: options.model,
            ...(hints.length > 0 ? { language_hints: hints } : {}),
            ...(options.contextText ? { context: { text: options.contextText } } : {}),
          },
          signal,
        );
        await client.waitForCompletion(transcriptionId, { signal, timeoutMs: options.pollTimeoutMs });
        const text = await client.getTranscript(transcriptionId, signal);
        return {
          text,
          audioSeconds: wavSeconds(input.audio) ?? 0,
          inferenceSeconds: Number(now() - started) / 1e9,
        };
      } finally {
        // Runs on success, failure and cancellation alike: Soniox bills for the
        // uploaded file until it is deleted.
        await client.cleanup({
          transcriptionId,
          fileId,
          onError: (message) => ctx?.logger?.debug?.(message),
        });
      }
    },
  };
}

/**
 * Register every configured recognizer and mount the TTS surface.
 *
 * The two halves attach to different seams, and a profile can have one without
 * the other: the STT half needs `speechToText` (declared in `inject`), while TTS
 * needs `connection` + `tools`, which a headless profile may not provide. So TTS
 * waits through `ctx.inject()` instead of forcing the whole plugin to depend on
 * the web stack.
 */
export function apply(ctx, config = {}) {
  const { providers, tts } = normalizeConfig(config);
  ctx.effect(() => {
    const disposers = providers.map((options) => ctx.speechToText.register(createProvider(options, ctx)));
    return () => {
      for (const dispose of disposers) void dispose();
    };
  });
  ctx.logger?.info?.(`[dsh-soniox] registered ${providers.length} Soniox speech provider(s)`);

  if (tts.enabled) {
    if (typeof ctx.inject !== 'function') {
      ctx.logger?.debug?.('[dsh-soniox] ctx.inject is unavailable; TTS surface not mounted');
    } else {
      ctx.inject(['connection', 'tools'], (scope) => {
        mountTts(scope, tts);
        scope.logger?.info?.(`[dsh-soniox] speech synthesis mounted (${tts.voice}, ${tts.model}, ${tts.format})`);
      });
    }
  }
}

export default Object.freeze({ name, inject, apply });
