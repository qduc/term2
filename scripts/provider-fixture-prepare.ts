#!/usr/bin/env node
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseFixtureEnvelope } from './provider-black-box/fixture-envelope.js';
import { sanitizeFixtureEnvelope, scanFixtureSecrets } from './provider-black-box/fixture-sanitizer.js';

const [recording] = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const accepted = process.argv.includes('--accept');
if (!recording) fail('Usage: provider:fixture:prepare <recording> [--accept]');
const source = parseFixtureEnvelope(await readFile(recording!, 'utf8'));
const { envelope, report } = sanitizeFixtureEnvelope(source);
const scan = scanFixtureSecrets(envelope);
if (!scan.safe)
  fail(`Secret scan failed: ${scan.findings.map((finding) => `${finding.kind} at ${finding.path}`).join(', ')}`);
const reviewPath = `${recording}.review.json`;
await writeFile(reviewPath, `${JSON.stringify({ envelope, report, secretScan: scan }, null, 2)}\n`, 'utf8');
if (!accepted) {
  console.log(`Review artifact written to ${reviewPath}. Re-run with --accept after human review.`);
  process.exit(0);
}
const destinationRoot = resolve('scripts/provider-black-box/fixtures');
const destinationDir = join(destinationRoot, safeName(envelope.provider));
await mkdir(destinationDir, { recursive: true });
const destination = await destinationFor(destinationDir, envelope);
await writeFile(destination, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
const provenance = join(destinationRoot, 'PROVENANCE.md');
const line = `- **${destination.slice(destinationRoot.length + 1)}** — captured ${envelope.capture.capturedAt}; SDK ${
  envelope.capture.sdkPackage
}@${envelope.capture.apiSdkVersion}; model family ${envelope.capture.modelFamily}; probe \`${
  envelope.capture.probeScenario
}\`; reviewer ${
  process.env.TERM2_FIXTURE_REVIEWER ?? 'human reviewer'
}. Recapture when the wire family or transport-relevant SDK major/minor changes.\n`;
await appendFile(provenance, line);
console.log(destination);

async function destinationFor(
  destinationDir: string,
  envelope: Awaited<ReturnType<typeof parseFixtureEnvelope>>,
): Promise<string> {
  const probeName = safeName(envelope.capture.probeScenario);
  const preferred = join(destinationDir, `${probeName}.json`);
  try {
    const existing = parseFixtureEnvelope(await readFile(preferred, 'utf8'));
    if (
      existing.provider === envelope.provider &&
      existing.wireFamily === envelope.wireFamily &&
      existing.transport === envelope.transport
    )
      return preferred;
  } catch {
    /* no compatible existing fixture */
  }
  return join(destinationDir, `${probeName}-${safeName(envelope.wireFamily)}.json`);
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '_');
}
function fail(message: string): never {
  console.error(`provider:fixture:prepare: ${message}`);
  process.exit(2);
}
