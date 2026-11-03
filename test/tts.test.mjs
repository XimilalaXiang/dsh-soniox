// TTS half: speakable text, cache, REST client, routes and the speak tool.
// Offline: every network call is injected.
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assert, test } from './helpers.mjs';
import { SpeechCache, speechId } from '../cache.mjs';
import { isSpeakable, speakableText } from '../speakable.mjs';
import { SonioxTts, SonioxTtsError, TTS_URL } from '../tts.mjs';
import { AUDIO_PATH, SPEAK_PATH, mountTts, prepareSpeech, speakToolSpec } from '../tts-host.mjs';
import { normalizeTts } from '../index.mjs';

const KEY = 'soniox-tts-test-key';
const AUDIO = new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3]);

/**
 * Config for one test. The key variable defaults to a name that is never set, so
 * a developer shell with SONIOX_API_KEY exported cannot turn an offline test
 * into a billed network call.
 */
function ttsConfig(overrides = {}) {
  return normalizeTts({ dataDir: overrides.dataDir ?? tmpdir(), apiKeyEnv: 'DSH_SONIOX_TEST_ABSENT', ...overrides });
}

/** Config that resolves a key, for the paths that need one. */
function keyedConfig(overrides = {}) {
  process.env.DSH_SONIOX_TTS_TEST_KEY = KEY;
  return ttsConfig({ apiKeyEnv: 'DSH_SONIOX_TTS_TEST_KEY', ...overrides });
}

/** A fetch stand-in that always answers with audio. */
function audioFetch({ status = 200, bytes = AUDIO, headers = {} } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : null });
    return {
      ok: status < 400,
      status,
      headers: { get: (name) => headers[name] ?? null },
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      json: async () => ({ error_type: 'invalid_request', error_message: `bad ${KEY}` }),
    };
  };
  return { fetchImpl, calls };
}

test('markdown is reduced to speakable prose', () => {
  const md = [
    '## 标题',
    '这是 **重点**，还有 `inline code` 和 [链接文字](https://example.com/x)。',
    '',
    '```js',
    'const x = 1;',
    '```',
    '',
    '| a | b |',
    '|---|---|',
    '| 1 | 2 |',
    '',
    '- 第一条',
    '2. 第二条',
    '',
    '![图](MEDIA:/tmp/a.png)',
    'MEDIA:/tmp/b.mp3',
    '看这里 👀 https://example.com/y',
    '---',
  ].join('\n');
  const spoken = speakableText(md);
  assert.match(spoken, /标题/);
  assert.match(spoken, /重点/);
  assert.match(spoken, /inline code/);
  assert.match(spoken, /链接文字/);
  assert.match(spoken, /第一条/);
  assert.match(spoken, /第二条/);
  for (const gone of ['**', '`', 'https://example.com', 'MEDIA:', 'const x = 1', '| a | b |', '👀', '##', '---']) {
    assert.equal(spoken.includes(gone), false, `expected ${gone} to be removed`);
  }
});

test('speakable text respects the length cap and only real words count', () => {
  assert.equal(speakableText('abcdef', { maxChars: 3 }), 'abc');
  assert.equal(isSpeakable('*** ---'), false);
  assert.equal(isSpeakable('好'), false);
  assert.equal(isSpeakable('ok'), true);
});

test('a request id covers text and every synthesis parameter', () => {
  const base = { text: '你好', model: 'tts-rt-v2', voice: 'Meilin', language: 'zh', format: 'mp3' };
  const id = speechId(base);
  assert.match(id, /^[a-f0-9]{32}$/);
  assert.equal(speechId({ ...base }), id);
  assert.notEqual(speechId({ ...base, voice: 'Daniel' }), id);
  assert.notEqual(speechId({ ...base, text: '你好！' }), id);
});

test('the cache round-trips audio with its metadata and prunes by size', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-soniox-cache-'));
  try {
    const cache = new SpeechCache(dir, { maxBytes: 1000 });
    assert.equal(await cache.get('0'.repeat(32)), null);
    await cache.put('a'.repeat(32), AUDIO, { contentType: 'audio/mpeg', characters: 3 });
    const meta = await cache.get('a'.repeat(32));
    assert.equal(meta.contentType, 'audio/mpeg');
    assert.equal(meta.bytes, AUDIO.length);
    assert.deepEqual(Array.from(await cache.read('a'.repeat(32))), Array.from(AUDIO));
    // Over the budget: the oldest entry is evicted, metadata included.
    await cache.put('b'.repeat(32), new Uint8Array(2000), { contentType: 'audio/mpeg' });
    assert.equal(await cache.read('b'.repeat(32)) !== null, true);
    assert.equal(await cache.read('a'.repeat(32)), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the REST client sends the documented body and no speed field', async () => {
  const { fetchImpl, calls } = audioFetch({ headers: { 'content-type': 'audio/mpeg' } });
  const tts = new SonioxTts({ key: KEY, fetchImpl });
  const result = await tts.synthesize({ text: '你好', model: 'tts-rt-v2', voice: 'Meilin', language: 'zh', format: 'mp3' });
  assert.equal(calls[0].url, TTS_URL);
  assert.deepEqual(calls[0].body, { model: 'tts-rt-v2', language: 'zh', voice: 'Meilin', audio_format: 'mp3', text: '你好' });
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(result.contentType, 'audio/mpeg');
  assert.equal(result.characters, 2);
});

test('the REST client refuses bad input before any request', async () => {
  const { fetchImpl, calls } = audioFetch();
  const tts = new SonioxTts({ key: KEY, fetchImpl });
  await assert.rejects(() => tts.synthesize({ text: '   ' }), /non-empty text/);
  await assert.rejects(() => tts.synthesize({ text: 'x'.repeat(11), maxCharacters: 10 }), /limit is 10/);
  await assert.rejects(() => new SonioxTts({ key: '' }).synthesize({ text: 'hi' }), /key is unavailable/);
  assert.equal(calls.length, 0);
});

test('a generic response content-type is replaced by the requested format', async () => {
  const { fetchImpl } = audioFetch({ headers: { 'content-type': 'application/octet-stream' } });
  const tts = new SonioxTts({ key: KEY, fetchImpl });
  const result = await tts.synthesize({ text: 'hi there', model: 'm', voice: 'v', language: 'zh', format: 'wav' });
  assert.equal(result.contentType, 'audio/wav');
});

test('TTS errors are redacted and an unknown format falls back to mp3', async () => {
  const { fetchImpl, calls } = audioFetch({ status: 400 });
  await assert.rejects(
    () => new SonioxTts({ key: KEY, fetchImpl }).synthesize({ text: 'hi', model: 'm', voice: 'v', language: 'zh', format: 'weird' }),
    (error) => {
      assert.ok(error instanceof SonioxTtsError);
      assert.equal(error.message.includes(KEY), false);
      assert.match(error.message, /HTTP 400/);
      assert.match(error.message, /\*\*\*/);
      return true;
    },
  );
  assert.equal(calls[0].body.audio_format, 'mp3');
});

test('prepareSpeech serves a cache hit without touching the network and cleans markdown', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-soniox-prepare-'));
  try {
    const config = keyedConfig({ dataDir: dir });
    const cache = new SpeechCache(dir);
    const { fetchImpl, calls } = audioFetch();
    const deps = { cache, ctx: {}, createTts: (key) => new SonioxTts({ key, fetchImpl }) };

    const first = await prepareSpeech(config, { text: '**你好**世界' }, deps);
    assert.equal(first.status, 200);
    assert.equal(first.body.cached, false);
    assert.equal(first.body.url, `${AUDIO_PATH}?id=${first.body.id}`);
    assert.equal(calls[0].body.text, '你好世界');

    const second = await prepareSpeech(config, { text: '**你好**世界' }, deps);
    assert.equal(second.body.cached, true);
    assert.equal(second.body.id, first.body.id);
    assert.equal(calls.length, 1, 'a cache hit must not re-synthesize');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('prepareSpeech reports empty, oversized and keyless requests', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-soniox-prepare2-'));
  try {
    const cache = new SpeechCache(dir);
    const config = ttsConfig({ dataDir: dir, maxCharacters: 5 });
    const empty = await prepareSpeech(config, { text: '```\ncode\n```' }, { cache, ctx: {} });
    assert.equal(empty.status, 422);
    const long = await prepareSpeech(config, { text: '一二三四五六七八', speakable: false }, { cache, ctx: {} });
    assert.equal(long.status, 413);
    const noKey = await prepareSpeech(ttsConfig({ dataDir: dir }), { text: 'hello there', speakable: false }, { cache, ctx: {} });
    assert.equal(noKey.status, 503);
    assert.match(noKey.body.error, /API key is unavailable/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Mount the routes against a fake service surface and return the handlers. */
function mountHarness(config) {
  const routes = new Map();
  const tools = [];
  const ctx = {
    logger: { info() {}, debug() {}, warn() {} },
    connection: { fetch: { register: (route) => { routes.set(route.path, route); return async () => routes.delete(route.path); } } },
    tools: { register: (tool) => tools.push(tool) },
    effect: (fn) => fn(),
  };
  const cache = new SpeechCache(config.dataDir);
  mountTts(ctx, config, { cache, registerTool: (tool) => tools.push(tool) });
  return { routes, tools, cache };
}

test('both routes register under /api and the browser surface is fetch-shaped', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-soniox-routes-'));
  try {
    const config = ttsConfig({ dataDir: dir });
    const { routes, cache } = mountHarness(config);
    assert.deepEqual([...routes.keys()].sort(), [AUDIO_PATH, SPEAK_PATH]);
    assert.deepEqual(routes.get(SPEAK_PATH).methods, ['POST']);
    assert.deepEqual(routes.get(AUDIO_PATH).methods, ['GET', 'HEAD']);

    const speak = routes.get(SPEAK_PATH).fetch;
    const audio = routes.get(AUDIO_PATH).fetch;

    assert.equal((await speak(new Request('http://x', { method: 'POST', body: 'not json' }))).status, 400);
    const unknown = await audio(new Request(`http://x${AUDIO_PATH}?id=${'f'.repeat(32)}`));
    assert.equal(unknown.status, 404);
    assert.equal((await audio(new Request(`http://x${AUDIO_PATH}?id=nope`))).status, 400);

    // A cached entry is served with playback-safe headers and exact bytes.
    const id = 'c'.repeat(32);
    await cache.put(id, AUDIO, { contentType: 'audio/mpeg', characters: 2 });
    const served = await audio(new Request(`http://x${AUDIO_PATH}?id=${id}`));
    assert.equal(served.status, 200);
    assert.equal(served.headers.get('content-type'), 'audio/mpeg');
    assert.match(served.headers.get('cache-control'), /no-transform/);
    assert.equal((await served.arrayBuffer()).byteLength, AUDIO.length);
    const head = await audio(new Request(`http://x${AUDIO_PATH}?id=${id}`, { method: 'HEAD' }));
    assert.equal(head.status, 200);
    assert.equal((await head.arrayBuffer()).byteLength, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the speak tool writes real audio bytes and reuses the cache', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-soniox-tool-'));
  try {
    const config = keyedConfig({ dataDir: dir });
    const cache = new SpeechCache(dir);
    const { fetchImpl, calls } = audioFetch();
    const createTts = (key) => new SonioxTts({ key, fetchImpl });
    const spec = speakToolSpec(config, {}, { cache, createTts });
    assert.equal(spec.name, 'speak');
    assert.equal(spec.parameters.format.enum.includes('mp3'), true);
    assert.equal(typeof spec.presentCall({ text: 'hi' }), 'object');

    const first = await spec.execute({ text: '你好**世界**' }, { signal: new AbortController().signal });
    assert.equal(first.cached, false);
    assert.equal(first.characters, 4, 'markdown markers are not billed');
    assert.deepEqual(Array.from(readFileSync(first.path)), Array.from(AUDIO));
    assert.equal(calls[0].body.text, '你好世界', 'markdown is stripped before synthesis');

    const second = await spec.execute({ text: '你好**世界**' }, {});
    assert.equal(second.cached, true);
    assert.equal(calls.length, 1, 'a repeat call must not re-synthesize');

    // An explicit relative name lands inside the configured directory.
    const named = await spec.execute({ text: '你好**世界**', file: 'note.mp3' }, {});
    assert.equal(named.path, join(dir, 'note.mp3'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the speak tool refuses a request with no key instead of writing a file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-soniox-tool2-'));
  try {
    const config = ttsConfig({ dataDir: dir });
    const cache = new SpeechCache(dir);
    const spec = speakToolSpec(config, {}, { cache });
    await assert.rejects(
      () => spec.execute({ text: 'hello there', speakable: false, format: 'mp3' }, {}),
      /API key is unavailable/,
    );
    // Nothing was written: the failure happened before any synthesis.
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
