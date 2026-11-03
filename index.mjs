// dsh-soniox — native BYOK Soniox speech-to-text provider for DeepSeek Harness.
//
// Registers one `SpeechProvider` (id `soniox`) into `ctx.speechToText`
// (@deepseek-ai/dsh-experimental-speech-to-text, the DSH voice-input service
// definition). The Host's own microphone UI then lists it next to any local
// recognizer, and the Remote path (`speechController`) works unchanged.
//
// Scope: speech-to-text only. DSH has no speech-synthesis service — the
// voice-input subsystem states outright that "streaming recognition and speech
// synthesis have no service methods" — so TTS is not part of this package.
//
// The provider receives one complete canonical 16 kHz mono PCM16 WAV and does
// no audio conversion: Soniox's file API auto-detects WAV headers.
import { readFileSync } from 'node:fs';

import { LANGUAGES, languageHints, normalizeLanguage } from './languages.mjs';
import { SonioxClient, SonioxError, wavSeconds } from './soniox.mjs';

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

/** `providers: [...]` registers several recognizers; a flat config one. */
export function normalizeConfig(config = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw invalid('config must be an object');
  if (config.providers !== undefined) {
    if (!Array.isArray(config.providers) || config.providers.length === 0) {
      throw invalid('providers must be a non-empty array');
    }
    const providers = config.providers.map((entry) => normalizeProvider(entry));
    if (new Set(providers.map((entry) => entry.id)).size !== providers.length) {
      throw invalid('provider ids must be unique');
    }
    return Object.freeze({ providers: Object.freeze(providers) });
  }
  return Object.freeze({ providers: Object.freeze([normalizeProvider(config)]) });
}

/**
 * Read the API key: the Host credential store, then an environment variable,
 * then a file.
 *
 * A `CredentialRef` in DSH is an environment-variable-shaped name that resolves
 * through the provider-managed store first and ambient fallbacks (`$DSH_HOME/.env`,
 * `process.env`) afterwards, so one `resolve()` call covers both the stored-secret
 * and the exported-variable case. Resolution happens per recording, so a key
 * stored later is picked up without restarting the Host.
 */
export async function resolveApiKey(options, ctx, { hasCredentials } = {}) {
  const credentials = hasCredentials ?? (typeof ctx?.get === 'function' ? ctx.get('credentials') : null);
  const ref = options.apiKeyRef ?? options.apiKeyEnv;
  if (ref && typeof credentials?.resolve === 'function') {
    try {
      const resolved = await credentials.resolve(ref);
      const value = typeof resolved?.value === 'string' ? resolved.value.trim() : '';
      if (value) return value;
    } catch {
      // An unreachable credential store falls through to the ambient layers.
    }
  }
  if (options.apiKeyEnv) {
    const value = process.env[options.apiKeyEnv];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  if (options.apiKeyFile) {
    try {
      const value = readFileSync(options.apiKeyFile, 'utf8').trim();
      if (value) return value;
    } catch {
      // A missing key file simply leaves the key empty; the caller reports it.
    }
  }
  return '';
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
      const key = await resolveApiKey(options, ctx);
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

/** Register every configured recognizer for the lifetime of this plugin. */
export function apply(ctx, config = {}) {
  const { providers } = normalizeConfig(config);
  ctx.effect(() => {
    const disposers = providers.map((options) => ctx.speechToText.register(createProvider(options, ctx)));
    return () => {
      for (const dispose of disposers) void dispose();
    };
  });
  ctx.logger?.info?.(`[dsh-soniox] registered ${providers.length} Soniox speech provider(s)`);
}

export default Object.freeze({ name, inject, apply });
