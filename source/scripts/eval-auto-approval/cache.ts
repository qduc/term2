import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export class ResponseCache {
  #cacheDir: string;

  constructor(cacheDir: string) {
    this.#cacheDir = cacheDir;
    if (!existsSync(this.#cacheDir)) {
      mkdirSync(this.#cacheDir, { recursive: true });
    }
  }

  get(key: any): any | null {
    const hash = this.#hash(key);
    const filePath = join(this.#cacheDir, `${hash}.json`);
    if (existsSync(filePath)) {
      try {
        return JSON.parse(readFileSync(filePath, 'utf-8'));
      } catch {
        return null;
      }
    }
    return null;
  }

  set(key: any, value: any): void {
    const hash = this.#hash(key);
    const filePath = join(this.#cacheDir, `${hash}.json`);
    writeFileSync(filePath, JSON.stringify(value, null, 2));
  }

  clear(): void {
    if (!existsSync(this.#cacheDir)) {
      return;
    }
    const files = readdirSync(this.#cacheDir);
    for (const file of files) {
      if (file.endsWith('.json')) {
        unlinkSync(join(this.#cacheDir, file));
      }
    }
  }

  prune(maxFiles: number): void {
    if (!existsSync(this.#cacheDir)) {
      return;
    }

    const files = readdirSync(this.#cacheDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => ({
        name: f,
        path: join(this.#cacheDir, f),
        mtime: statSync(join(this.#cacheDir, f)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime);

    if (files.length > maxFiles) {
      const toDelete = files.slice(maxFiles);
      for (const file of toDelete) {
        unlinkSync(file.path);
      }
    }
  }

  #hash(data: any): string {
    return createHash('sha256').update(JSON.stringify(data)).digest('hex');
  }
}
