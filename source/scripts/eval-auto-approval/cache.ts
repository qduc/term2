import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
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

  #hash(data: any): string {
    return createHash('sha256').update(JSON.stringify(data)).digest('hex');
  }
}
