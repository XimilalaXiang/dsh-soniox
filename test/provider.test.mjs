// Config, language and registration tests: no network.
import { assert, test, wav } from './helpers.mjs';
import { LANGUAGES, languageHints, normalizeLanguage } from '../languages.mjs';
import { createProvider, normalizeConfig, normalizeProvider, resolveApiKey } from '../index.mjs';

test('regions are stripped from language codes', () => {
  assert.equal(normalizeLanguage('zh-CN'), 'zh');
  assert.equal(normalizeLanguage('EN_us'), 'en');
  assert.equal(normalizeLanguage(''), null);
  assert.equal(normalizeLanguage(42), null);
});

test('language hints prefer the recording selection, then the config', () => {
  assert.deepEqual(languageHints('zh', 'en,ja'), ['zh']);
  assert.deepEqual(languageHints('auto', 'en,ja'), ['en', 'ja']);
  assert.deepEqual(languageHints('', 'zh-CN, zh, en'), ['zh', 'en']);
  assert.deepEqual(languageHints('auto', 'auto'), []);
  assert.deepEqual(languageHints('zh', null), ['zh']);
});

test('defaults match the documented Soniox settings', () => {
  const options = normalizeProvider({});
  assert.equal(options.model, 'stt-async-v5');
  assert.equal(options.apiKeyEnv, 'SONIOX_API_KEY');
  assert.equal(options.pollTimeoutMs, 60_000);
  assert.deepEqual(options.languages, LANGUAGES);
  assert.ok(options.languages.includes('auto'));
});

test('a config with no model speaks bare ISO codes and always offers auto', () => {
  assert.deepEqual(normalizeProvider({ languages: ['zh-CN', 'en'] }).languages, ['auto', 'zh', 'en']);
});

test('a flat config is one provider and a bad one fails at load time', () => {
  assert.equal(normalizeConfig({ model: 'stt-async-v5' }).providers.length, 1);
  assert.equal(normalizeConfig({ providers: [{ id: 'a' }, { id: 'b' }] }).providers.length, 2);
  assert.throws(() => normalizeConfig({ providers: [] }), /non-empty array/);
  assert.throws(() => normalizeConfig({ providers: [{ id: 'a' }, { id: 'a' }] }), /unique/);
  assert.throws(() => normalizeConfig({ pollTimeoutMs: -1 }), /positive integer/);
  assert.throws(() => normalizeConfig({ model: '' }), /non-empty string/);
});

test('the key resolves from the credential store, the environment, or a file', async () => {
  const env = 'DSH_SONIOX_TEST_KEY';
  process.env[env] = 'from-env';
  try {
    // The store wins over the exported variable, as it does elsewhere in DSH.
    assert.equal(
      await resolveApiKey({ apiKeyEnv: env }, {}, { hasCredentials: { resolve: async () => ({ value: 'from-store' }) } }),
      'from-store',
    );
    // Without a store the environment supplies it.
    assert.equal(await resolveApiKey({ apiKeyEnv: env }, {}), 'from-env');
    // An unreachable store does not break the ambient layers.
    assert.equal(
      await resolveApiKey({ apiKeyEnv: env }, {}, { hasCredentials: { resolve: async () => { throw new Error('down'); } } }),
      'from-env',
    );
    assert.equal(await resolveApiKey({ apiKeyEnv: 'DSH_SONIOX_TEST_MISSING' }, {}), '');
  } finally {
    delete process.env[env];
  }
});

/** A provider wired to a scripted client, so registration logic is testable. */
function harness({ key = 'k' } = {}) {
  const seen = {};
  const client = {
    async uploadFile(audio, filename, signal) {
      seen.upload = { bytes: audio.length, filename, aborted: signal?.aborted ?? false };
      return 'file-1';
    },
    async createTranscription(body) {
      seen.body = body;
      return 'tr-1';
    },
    async waitForCompletion(id, options) {
      seen.poll = { id, timeoutMs: options.timeoutMs };
    },
    async getTranscript() {
      return '识别结果';
    },
    async cleanup(args) {
      seen.cleanup = args;
    },
  };
  const options = normalizeProvider({ apiKeyEnv: 'DSH_SONIOX_TEST_KEY' });
  process.env[options.apiKeyEnv] = key;
  return { provider: createProvider(options, {}, { createClient: () => client }), seen };
}

test('the provider advertises the cloud location and DSH languages', () => {
  const { provider } = harness();
  assert.equal(provider.info.id, 'soniox');
  assert.equal(provider.info.location, 'cloud');
  assert.ok(provider.info.languages.includes('auto'));
});

test('transcribe uploads, creates with hints, and reports a transcript', async () => {
  const { provider, seen } = harness();
  const result = await provider.transcribe({ audio: wav(1.5), language: 'zh' }, new AbortController().signal);
  assert.equal(result.text, '识别结果');
  assert.equal(result.audioSeconds, 1.5);
  assert.equal(seen.upload.filename, 'audio.wav');
  assert.deepEqual(seen.body, { file_id: 'file-1', model: 'stt-async-v5', language_hints: ['zh'] });
  assert.equal(seen.cleanup.fileId, 'file-1');
  assert.equal(seen.cleanup.transcriptionId, 'tr-1');
});

test('an auto language sends no hints and context text is forwarded', async () => {
  const { provider, seen } = harness();
  const options = normalizeProvider({
    apiKeyEnv: 'DSH_SONIOX_TEST_KEY',
    contextText: 'Soniox, DeepSeek Harness',
  });
  process.env[options.apiKeyEnv] = 'k';
  const providerWithContext = createProvider(options, {}, { createClient: () => ({
    async uploadFile() { return 'file-1'; },
    async createTranscription(body) { seen.body = body; return 'tr-1'; },
    async waitForCompletion() {},
    async getTranscript() { return 'ok'; },
    async cleanup() {},
  }) });
  await providerWithContext.transcribe({ audio: wav(1), language: 'auto' }, undefined);
  assert.deepEqual(seen.body, {
    file_id: 'file-1',
    model: 'stt-async-v5',
    context: { text: 'Soniox, DeepSeek Harness' },
  });
  assert.equal(provider.info.id, 'soniox');
});

test('a missing key fails before any upload, and remote cleanup still runs on failure', async () => {
  const options = normalizeProvider({ apiKeyEnv: 'DSH_SONIOX_TEST_ABSENT' });
  delete process.env[options.apiKeyEnv];
  const withMissingKey = createProvider(options, {}, { createClient: () => { throw new Error('must not be called'); } });
  await assert.rejects(
    () => withMissingKey.transcribe({ audio: wav(1), language: 'zh' }, undefined),
    /API key is unavailable/,
  );

  const cleaned = [];
  const failing = normalizeProvider({ apiKeyEnv: 'DSH_SONIOX_TEST_KEY2' });
  process.env[failing.apiKeyEnv] = 'k';
  const provider = createProvider(failing, {}, {
    createClient: () => ({
      async uploadFile() { return 'file-9'; },
      async createTranscription() { return 'tr-9'; },
      async waitForCompletion() { throw new Error('soniox down'); },
      async getTranscript() { return ''; },
      async cleanup(args) { cleaned.push(args); },
    }),
  });
  await assert.rejects(() => provider.transcribe({ audio: wav(1), language: 'zh' }, undefined), /soniox down/);
  assert.equal(cleaned[0].fileId, 'file-9');
});

test('registration goes through ctx.effect and unregisters on disposal', () => {
  const registered = [];
  const disposed = [];
  let disposer;
  const ctx = {
    speechToText: { register: (provider) => { registered.push(provider); return async () => disposed.push(provider.info.id); } },
    effect: (fn) => { disposer = fn(); },
    logger: { info() {}, debug() {} },
  };
  const apply = (config) => import('../index.mjs').then((m) => m.apply(ctx, config));
  return apply({ model: 'stt-async-v5' }).then(async () => {
    assert.deepEqual(registered.map((p) => p.info.id), ['soniox']);
    await disposer();
    assert.deepEqual(disposed, ['soniox']);
  });
});
