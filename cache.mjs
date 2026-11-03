// Content-addressed audio cache.
//
// The same reply is replayed often (a button pressed twice, a retried request, a
// re-opened session), and Soniox bills per character. One hash covers the whole
// request shape, so an unchanged request never reaches the network twice.
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Stable id for one synthesis request. */
export function speechId(request) {
  const shape = [
    request.text,
    request.model,
    request.voice,
    request.language,
    request.format,
    request.sampleRate ?? '',
    request.bitrate ?? '',
  ].join('\u0000');
  return createHash('sha256').update(shape).digest('hex').slice(0, 32);
}

/**
 * One directory of `<id>.audio` + `<id>.json` pairs.
 *
 * Metadata is kept out of the filename so the format can change without
 * invalidating an id, and so a cache hit needs no audio read.
 */
export class SpeechCache {
  constructor(directory, { maxBytes = 64 * 1024 * 1024 } = {}) {
    this.directory = directory;
    this.maxBytes = maxBytes;
  }

  #audio(id) {
    return join(this.directory, `${id}.audio`);
  }

  #meta(id) {
    return join(this.directory, `${id}.json`);
  }

  /** @returns cached metadata, or null when the entry is missing or corrupt. */
  async get(id) {
    try {
      const meta = JSON.parse(await readFile(this.#meta(id), 'utf8'));
      if (!meta || typeof meta !== 'object' || !meta.contentType) return null;
      await stat(this.#audio(id));
      return meta;
    } catch {
      return null;
    }
  }

  async read(id) {
    try {
      return new Uint8Array(await readFile(this.#audio(id)));
    } catch {
      return null;
    }
  }

  async put(id, bytes, meta) {
    await mkdir(this.directory, { recursive: true });
    // Metadata last: a reader that sees metadata is guaranteed to see the audio.
    await writeFile(this.#audio(id), bytes);
    await writeFile(this.#meta(id), JSON.stringify({ ...meta, bytes: bytes.length, createdAt: Date.now() }));
    await this.prune();
  }

  /** Keep the directory under `maxBytes`, oldest first (called after each write). */
  async prune() {
    let entries;
    try {
      entries = await readdir(this.directory);
    } catch {
      return;
    }
    const files = await Promise.all(
      entries
        .filter((name) => name.endsWith('.audio'))
        .map(async (name) => {
          try {
            const info = await stat(join(this.directory, name));
            return { name, size: info.size, at: info.mtimeMs };
          } catch {
            return null;
          }
        }),
    );
    const alive = files.filter(Boolean).sort((a, b) => a.at - b.at);
    let total = alive.reduce((sum, file) => sum + file.size, 0);
    // The newest entry is always kept: evicting what was just written would make
    // `put` silently useless for a clip larger than the whole budget, and the
    // caller has already paid for it.
    for (let index = 0; index < alive.length - 1; index += 1) {
      if (total <= this.maxBytes) break;
      const file = alive[index];
      const id = file.name.slice(0, -'.audio'.length);
      await unlink(join(this.directory, file.name)).catch(() => {});
      await unlink(this.#meta(id)).catch(() => {});
      total -= file.size;
    }
  }
}
