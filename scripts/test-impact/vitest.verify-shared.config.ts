import fs from 'node:fs';
import { defineConfig } from 'vitest/config';
import base from '../../vitest.config';

// Config used only by verify-shared.mjs: runs the files listed in
// $SHARED_MANIFEST unisolated, with files and tests shuffled by $SEED.
const manifest = fs
  .readFileSync(process.env.SHARED_MANIFEST!, 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#') && fs.existsSync(line));

export default defineConfig({
  test: {
    ...base.test!,
    include: manifest,
    isolate: false,
    sequence: { shuffle: true, seed: Number(process.env.SEED) },
  },
});
