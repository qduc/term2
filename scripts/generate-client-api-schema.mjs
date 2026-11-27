#!/usr/bin/env node
/**
 * Generates `docs/plans/daemon/spec/client-api.schema.json` directly from the authoritative
 * TypeScript/Zod schema in `src/protocol/client-api/client-api-schema.ts`.
 * Run with `--check` to verify the committed JSON Schema is up to date.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { CLIENT_API_SCHEMAS } from '../src/protocol/client-api/client-api-schema.ts';
import { CLIENT_API_VERSION } from '../src/protocol/client-api/version-negotiation.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = path.join(root, 'docs', 'plans', 'daemon', 'spec', 'client-api.schema.json');

export function buildClientApiJsonSchema() {
  const defs = {};
  for (const [name, schema] of Object.entries(CLIENT_API_SCHEMAS)) {
    const jsonSchema = z.toJSONSchema(schema, { target: 'draft-2020-12' });
    delete jsonSchema.$schema;
    defs[name] = jsonSchema;
  }
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `https://term2.dev/schemas/client-api/${CLIENT_API_VERSION}/schema.json`,
    title: `Term2 Client API v${CLIENT_API_VERSION}`,
    description:
      'Generated from src/protocol/client-api/client-api-schema.ts. Do not hand-edit; run `node --import tsx scripts/generate-client-api-schema.mjs`.',
    $defs: defs,
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const rendered = `${JSON.stringify(buildClientApiJsonSchema(), null, 2)}\n`;
  if (process.argv.includes('--check')) {
    const existing = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : '';
    if (existing !== rendered) {
      console.error('docs/plans/daemon/spec/client-api.schema.json is out of date. Run: node --import tsx scripts/generate-client-api-schema.mjs');
      process.exit(1);
    }
    console.log('client-api.schema.json is up to date.');
  } else {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, rendered, 'utf8');
    console.log(`Wrote ${path.relative(root, outputPath)}`);
  }
}
