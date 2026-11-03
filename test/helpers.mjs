// Shared test helpers. Kept out of the *.test.mjs files so importing a helper
// never re-registers another file's tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';

/** Canonical 16 kHz mono PCM16 WAV with `seconds` of silence. */
export function wav(seconds = 1, { extraChunk = false } = {}) {
  const samples = Math.round(16_000 * seconds);
  const data = Buffer.alloc(samples * 2);
  // Encoders such as ffmpeg insert a LIST chunk before `data`; a duration
  // parser that assumes a 44-byte header reads a wrong length there.
  const list = extraChunk ? Buffer.concat([Buffer.from('LIST'), (() => { const b = Buffer.alloc(4 + 8); b.writeUInt32LE(8, 0); b.write('INFOISFT', 4); return b; })()]) : Buffer.alloc(0);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length + list.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16_000, 24);
  header.writeUInt32LE(32_000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  if (extraChunk) {
    // Reuse the reserved fmt/`data` layout: fmt, then LIST, then data.
    const clean = Buffer.alloc(36);
    header.copy(clean, 0, 0, 36);
    const dataHeader = Buffer.alloc(8);
    dataHeader.write('data', 0);
    dataHeader.writeUInt32LE(data.length, 4);
    return new Uint8Array(Buffer.concat([clean, list, dataHeader, data]));
  }
  return new Uint8Array(Buffer.concat([header, data]));
}

/** A fetch stand-in that answers a scripted list of responses. */
export function scripted(responses) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected request: ${init.method ?? 'GET'} ${url}`);
    if (next instanceof Error) throw next;
    return {
      ok: (next.status ?? 200) < 400,
      status: next.status ?? 200,
      json: async () => {
        if (next.body === undefined) throw new Error('not json');
        return next.body;
      },
    };
  };
  return { fetchImpl, calls };
}

export { test, assert };
