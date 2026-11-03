// In-process integration check against the real DSH voice-input service.
//
// Boots @deepseek-ai/cordis with the actual
// @deepseek-ai/dsh-experimental-speech-to-text service, mounts dsh-soniox into
// it exactly as the Host does, and drives the public surface:
//
//   ctx.speechToText.listProviders()  -> what the microphone UI would list
//   ctx.speechToText.snapshot()       -> provider readiness + saved selection
//   ctx.speechToText.resolve()        -> language validation
//   ctx.speechToText.transcribe()     -> the real Soniox round trip
//
// Run it from inside the DSH runtime so its packages resolve:
//
//   cd "$DSH_ROOT" && SONIOX_API_KEY=... node /path/to/dsh-soniox/scripts/dsh-integration.mjs
//
// DSH_ROOT defaults to /home/ubuntu/apps/deepseek-harness; it only needs the
// framework plus the speech service, not a booted profile.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dshRoot = process.env.DSH_ROOT ?? '/home/ubuntu/apps/deepseek-harness';
/** dsh-soniox lives outside the runtime, so Host packages load by absolute path. */
const fromRuntime = (pkg, entry = 'lib/index.js') =>
  pathToFileURL(join(dshRoot, 'node_modules', ...pkg.split('/'), entry)).href;

const key = process.env.SONIOX_API_KEY?.trim();
if (!key) {
  console.error('SONIOX_API_KEY is not set');
  process.exit(2);
}

const { Context } = await import(fromRuntime('@deepseek-ai/cordis'));
const speechToText = await import(fromRuntime('@deepseek-ai/dsh-experimental-speech-to-text'));
const soniox = await import(new URL('../index.mjs', import.meta.url).href);

const ctx = new Context();
ctx.plugin(speechToText.default, { defaultProvider: 'soniox', language: 'auto' });
ctx.plugin(soniox.default, { model: process.env.SONIOX_STT_MODEL ?? 'stt-async-v5' });
await new Promise((resolve) => setTimeout(resolve, 50));

const providers = ctx.speechToText.listProviders();
console.log('providers:', providers.map((p) => `${p.id} (${p.location}, langs ${p.languages.length})`).join(', '));
if (!providers.some((p) => p.id === 'soniox' && p.location === 'cloud')) {
  console.error('FAIL: the Soniox provider did not register');
  process.exit(1);
}
console.log('snapshot:', JSON.stringify(ctx.speechToText.snapshot().selection));

// A language the provider does not advertise must be refused by the service.
try {
  ctx.speechToText.resolve({ audio: new Uint8Array(0), language: 'xx-not-a-code' });
  console.error('FAIL: an unsupported language was accepted');
  process.exit(1);
} catch (error) {
  console.log('language guard:', error.message);
}

// Real audio: Soniox TTS -> canonical 16 kHz mono PCM16 WAV -> service transcribe.
const workspace = mkdtempSync(join(tmpdir(), 'dsh-soniox-integration-'));
try {
  const sentence = '你好，这是 dsh-soniox 通过 DSH 语音服务的集成验证。';
  const tts = await fetch('https://tts-rt.soniox.com/tts', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'tts-rt-v2', language: 'zh', voice: 'Meilin', audio_format: 'wav', text: sentence }),
  });
  if (!tts.ok) throw new Error(`TTS HTTP ${tts.status}: ${(await tts.text()).slice(0, 200)}`);
  const raw = join(workspace, 'raw.wav');
  const canonical = join(workspace, 'canonical.wav');
  writeFileSync(raw, Buffer.from(await tts.arrayBuffer()));
  const ffmpeg = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', raw, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', canonical]);
  if (ffmpeg.status !== 0) throw new Error(`ffmpeg: ${ffmpeg.stderr?.toString().slice(0, 200)}`);
  const audio = new Uint8Array(readFileSync(canonical));

  const started = Date.now();
  const spec = ctx.speechToText.resolve({ audio, language: 'zh' });
  const transcript = await ctx.speechToText.transcribe(spec, new AbortController().signal);
  console.log(`\ntranscribe() ok in ${Date.now() - started}ms`);
  console.log(`  expected:   ${sentence}`);
  console.log(`  text:       ${transcript.text}`);
  console.log(`  audioSeconds: ${transcript.audioSeconds}  inferenceSeconds: ${transcript.inferenceSeconds.toFixed(2)}`);
  const hit = ['dsh', 'soniox', 'DSH', '集成', '验证'].filter((n) => transcript.text.toLowerCase().includes(n.toLowerCase()));
  console.log(`  matched:    ${hit.join(', ') || '(none)'}`);
  if (!transcript.text || !hit.length) {
    console.error('FAIL: transcript did not contain the expected markers');
    process.exitCode = 1;
  }
} finally {
  rmSync(workspace, { recursive: true, force: true });
  await ctx.stop?.().catch?.(() => {});
}
