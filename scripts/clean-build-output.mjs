import { rm } from 'node:fs/promises';

const outputDirectory = process.argv[2] ?? new URL('../dist/', import.meta.url);

await rm(outputDirectory, { recursive: true, force: true });
