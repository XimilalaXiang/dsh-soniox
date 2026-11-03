// Mocked-HTTP tests for the Soniox client: no credentials, no network.
import { assert, scripted, test, wav } from './helpers.mjs';
import { SonioxClient, SonioxError, transcriptText, wavSeconds } from '../soniox.mjs';

const key = 'soniox-test-key';

test('client sends the key only in the Authorization header', async () => {
  const { fetchImpl, calls } = scripted([{ body: { id: 'file-1' } }]);
  const client = new SonioxClient({ key, fetchImpl });
  assert.equal(await client.uploadFile(wav(), 'audio.wav'), 'file-1');
  const [call] = calls;
  assert.equal(call.url, 'https://api.soniox.com/v1/files');
  assert.equal(call.init.headers.Authorization, `Bearer ${key}`);
  assert.ok(call.init.body instanceof FormData);
  assert.equal(JSON.stringify(call).includes('"key"'), false);
});

test('errors never leak the API key', async () => {
  const { fetchImpl } = scripted([
    { status: 401, body: { error_type: 'unauthorized', error_message: `bad key ${key}` } },
  ]);
  const client = new SonioxClient({ key, fetchImpl });
  await assert.rejects(
    () => client.uploadFile(wav()),
    (error) => {
      assert.ok(error instanceof SonioxError);
      assert.equal(error.message.includes(key), false);
      assert.match(error.message, /HTTP 401/);
      assert.match(error.message, /\*\*\*/);
      return true;
    },
  );
});

test('polling waits for completed and returns the transcript', async () => {
  const { fetchImpl, calls } = scripted([
    { body: { status: 'queued' } },
    { body: { status: 'processing' } },
    { body: { status: 'completed' } },
    { body: { text: '  你好世界  ' } },
  ]);
  const client = new SonioxClient({ key, fetchImpl });
  await client.waitForCompletion('tr-1', { initialDelayMs: 1, maxDelayMs: 2 });
  assert.equal(await client.getTranscript('tr-1'), '你好世界');
  assert.equal(calls.at(-1).url, 'https://api.soniox.com/v1/transcriptions/tr-1/transcript');
});

test('a token-list transcript is joined', () => {
  assert.equal(transcriptText({ tokens: [{ text: '你好' }, { text: '，' }, { text: '世界' }] }), '你好，世界');
  assert.throws(() => transcriptText({}), SonioxError);
});

test('a terminal error status fails with a redacted reason', async () => {
  const { fetchImpl } = scripted([
    { body: { status: 'error', error_type: 'invalid_request', error_message: `model unknown ${key}` } },
  ]);
  const client = new SonioxClient({ key, fetchImpl });
  await assert.rejects(
    () => client.waitForCompletion('tr-2', { initialDelayMs: 1 }),
    (error) => {
      assert.equal(error.message.includes(key), false);
      assert.match(error.message, /invalid_request/);
      return true;
    },
  );
});

test('polling gives up at the timeout instead of hanging', async () => {
  const { fetchImpl } = scripted(Array.from({ length: 50 }, () => ({ body: { status: 'processing' } })));
  const client = new SonioxClient({ key, fetchImpl });
  await assert.rejects(
    () => client.waitForCompletion('tr-3', { timeoutMs: 30, initialDelayMs: 1, maxDelayMs: 2 }),
    /timed out after 30ms/,
  );
});

test('an aborted signal stops the poll immediately', async () => {
  const { fetchImpl } = scripted([{ body: { status: 'processing' } }]);
  const client = new SonioxClient({ key, fetchImpl });
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error('cancelled')), 5);
  await assert.rejects(
    () => client.waitForCompletion('tr-4', { signal: controller.signal, initialDelayMs: 50, maxDelayMs: 50 }),
    /cancelled/,
  );
});

test('cleanup deletes remote resources and never throws', async () => {
  const { fetchImpl, calls } = scripted([{ status: 204 }, { status: 500, body: { error_message: 'gone' } }]);
  const client = new SonioxClient({ key, fetchImpl });
  const failures = [];
  await client.cleanup({ transcriptionId: 'tr-5', fileId: 'file-5', onError: (m) => failures.push(m) });
  assert.deepEqual(
    calls.map((c) => [c.init.method, c.url]),
    [
      ['DELETE', 'https://api.soniox.com/v1/transcriptions/tr-5'],
      ['DELETE', 'https://api.soniox.com/v1/files/file-5'],
    ],
  );
  assert.equal(failures.length, 1);
});

test('wavSeconds reads a canonical WAV and rejects foreign containers', () => {
  assert.equal(wavSeconds(wav(2)), 2);
  // ffmpeg-style extra chunk before `data` must not break the length read.
  assert.equal(wavSeconds(wav(1.5, { extraChunk: true })), 1.5);
  const stereo = wav(1);
  new DataView(stereo.buffer).setUint16(22, 2, true);
  assert.equal(wavSeconds(stereo), null);
  assert.equal(wavSeconds(new Uint8Array([1, 2, 3])), null);
});
