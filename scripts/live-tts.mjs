// Live TTS check: real Soniox synthesis through the routes and the agent tool.
//
//   SONIOX_API_KEY=... node scripts/live-tts.mjs
//
// It mounts the TTS surface against a stand-in service host, then:
//   1. POSTs to the speak route and asserts the audio really decodes (ffprobe);
//   2. repeats the request and asserts the second one is a cache hit;
//   3. fetches the audio route and compares bytes with what the tool wrote;
//   4. resolves the Host's own `defineTool` and runs the tool end to end.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SpeechCache } from '../cache.mjs';
import { normalizeTts } from '../index.mjs';
import { importHostPackage } from '../runtime.mjs';
import { AUDIO_PATH, SPEAK_PATH, mountTts, speakToolSpec } from '../tts-host.mjs';

const TEXT = '你好，这是 dsh-soniox 的语音合成验证。**加粗**和 `行内代码` 都应该被正常朗读。';
const workspace = mkdtempSync(join(tmpdir(), 'dsh-soniox-tts-live-'));

// Resolve the Host packages from an explicit runtime when the script is not
// running inside one.
process.env.DSH_ROOT ??= '/home/ubuntu/apps/deepseek-harness';

const config = normalizeTts({
  dataDir: workspace,
  voice: process.env.SONIOX_TTS_VOICE ?? 'Meilin',
  language: 'zh',
  format: 'mp3',
});

const routes = new Map();
const tools = [];
const ctx = {
  logger: { info: (m) => console.log('  log:', m), debug() {}, warn: (m) => console.error('  warn:', m) },
  connection: { fetch: { register: (route) => { routes.set(route.path, route); return async () => {}; } } },
  tools: { register: (tool) => tools.push(tool) },
  effect: (fn) => fn(),
};

const cache = new SpeechCache(workspace);
mountTts(ctx, config, { cache });
console.log(`routes mounted: ${[...routes.keys()].join(', ')}`);

const post = (body) =>
  routes.get(SPEAK_PATH).fetch(
    new Request(`http://127.0.0.1${SPEAK_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );

try {
  const started = Date.now();
  const first = await post({ text: TEXT });
  const firstBody = await first.json();
  console.log(`\nspeak route: HTTP ${first.status} in ${Date.now() - started}ms`, firstBody);
  if (first.status !== 200 || firstBody.cached !== false) throw new Error('first synthesis failed');

  const repeat = await post({ text: TEXT });
  const repeatBody = await repeat.json();
  console.log('repeat request ->', { cached: repeatBody.cached, id: repeatBody.id });
  if (repeatBody.cached !== true || repeatBody.id !== firstBody.id) throw new Error('cache hit was not served');

  const audio = await routes.get(AUDIO_PATH).fetch(new Request(`http://127.0.0.1${AUDIO_PATH}?id=${firstBody.id}`));
  const bytes = Buffer.from(await audio.arrayBuffer());
  const file = join(workspace, 'route.mp3');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(file, bytes);
  console.log(`audio route: HTTP ${audio.status} ${bytes.length} bytes, content-type ${audio.headers.get('content-type')}`);

  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration,format_name', '-of', 'json', file], { encoding: 'utf8' });
  if (probe.status !== 0) throw new Error(`the fetched audio does not decode: ${probe.stderr}`);
  const info = JSON.parse(probe.stdout).format;
  console.log('decoded by ffprobe ->', info);

  // The agent tool path, through the Host's own defineTool.
  const toolsPkg = await importHostPackage('@deepseek-ai/dsh-tools');
  console.log(`\nhost defineTool resolved: ${typeof toolsPkg?.defineTool}`);
  if (toolsPkg?.defineTool) {
    const hostTool = toolsPkg.defineTool(speakToolSpec(config, ctx, { cache }));
    const result = await hostTool.execute({ text: '第二条语音，验证工具写入。', format: 'wav' }, {});
    console.log('tool execute ->', result, `(${statSync(result.path).size} bytes on disk)`);
    const toolProbe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration,format_name', '-of', 'json', result.path], { encoding: 'utf8' });
    if (toolProbe.status !== 0) throw new Error('the tool output does not decode');
    console.log('tool audio decodes ->', JSON.parse(toolProbe.stdout).format);
    if (!Array.isArray(hostTool.parameters) && typeof hostTool.parameters !== 'object') throw new Error('unexpected tool shape');
    console.log('tool shape ->', { name: hostTool.name, parameters: typeof hostTool.parameters, output: typeof hostTool.output });
  }
  console.log('\nPASS');
} catch (error) {
  console.error('\nFAIL:', error.message);
  process.exitCode = 1;
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
