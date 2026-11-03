// Live end-to-end check against the real Soniox API.
//
// Not part of `npm test` (that suite is offline and credential-free). Run it
// with a real key to prove the whole path works:
//
//   SONIOX_API_KEY=... node scripts/live-check.mjs
//
// It synthesizes Chinese speech with Soniox TTS, converts it to the exact
// container DSH hands a provider (16 kHz mono PCM16 WAV), transcribes it
// through ./soniox.mjs, and verifies the remote resources were deleted.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SonioxClient, wavSeconds } from '../soniox.mjs';

const TTS_URL = 'https://tts-rt.soniox.com/tts';
const SENTENCE = '你好，这是 dsh-soniox 的端到端验证。请把这句话转写出来。';

const key = process.env.SONIOX_API_KEY?.trim();
if (!key) {
  console.error('SONIOX_API_KEY is not set');
  process.exit(2);
}

const ttsResponse = await fetch(TTS_URL, {
  method: 'POST',
  headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: process.env.SONIOX_TTS_MODEL ?? 'tts-rt-v2',
    language: 'zh',
    voice: process.env.SONIOX_TTS_VOICE ?? 'Meilin',
    audio_format: 'wav',
    text: SENTENCE,
  }),
});
if (!ttsResponse.ok) {
  console.error(`TTS HTTP ${ttsResponse.status}: ${(await ttsResponse.text()).slice(0, 300)}`);
  process.exit(1);
}
const synthesized = Buffer.from(await ttsResponse.arrayBuffer());
console.log(`TTS ok: ${synthesized.length} bytes of wav`);

// DSH always hands a provider canonical 16 kHz mono PCM16 WAV, so the check
// transcribes exactly that shape rather than the TTS-native container.
const workspace = mkdtempSync(join(tmpdir(), 'dsh-soniox-live-'));
const rawPath = join(workspace, 'tts.wav');
const canonicalPath = join(workspace, 'canonical.wav');
writeFileSync(rawPath, synthesized);
const ffmpeg = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', rawPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', canonicalPath]);
if (ffmpeg.status !== 0) {
  console.error(`ffmpeg failed: ${ffmpeg.stderr?.toString().slice(0, 300)}`);
  process.exit(1);
}
const { readFileSync } = await import('node:fs');
const audio = new Uint8Array(readFileSync(canonicalPath));

const client = new SonioxClient({ key });
const started = Date.now();
let fileId;
let transcriptionId;
try {
  fileId = await client.uploadFile(audio, 'live-check.wav');
  transcriptionId = await client.createTranscription({
    file_id: fileId,
    model: process.env.SONIOX_STT_MODEL ?? 'stt-async-v5',
    language_hints: ['zh'],
  });
  await client.waitForCompletion(transcriptionId, { timeoutMs: 120_000 });
  const text = await client.getTranscript(transcriptionId);
  console.log(`\nSTT ok in ${Date.now() - started}ms`);
  console.log(`  audio:      ${wavSeconds(audio)?.toFixed(2)}s (canonical 16 kHz mono PCM16)`);
  console.log(`  expected:   ${SENTENCE}`);
  console.log(`  transcript: ${text}`);
  const hit = ['dsh', 'soniox', '端到端', '验证'].filter((needle) => text.toLowerCase().includes(needle.toLowerCase()));
  console.log(`  matched:    ${hit.join(', ') || '(none)'}`);
  if (!hit.length) process.exitCode = 1;
} finally {
  await client.cleanup({ transcriptionId, fileId, onError: (m) => console.error(m) });
  // Prove the remote objects are gone rather than trusting the DELETE.
  for (const [label, path] of [
    ['transcription', transcriptionId && `/transcriptions/${transcriptionId}`],
    ['file', fileId && `/files/${fileId}`],
  ]) {
    if (!path) continue;
    const probe = await fetch(`https://api.soniox.com/v1${path}`, { headers: { Authorization: `Bearer ${key}` } });
    console.log(`  cleanup:    ${label} -> HTTP ${probe.status}`);
    if (probe.status === 200) process.exitCode = 1;
  }
  rmSync(workspace, { recursive: true, force: true });
}
