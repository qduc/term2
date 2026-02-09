#!/usr/bin/env node
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  extractProviderTrafficFromLogContent,
  writeProviderTrafficFiles,
} from '../utils/provider-traffic-extractor.js';

async function main() {
  const [, , logFileArg, outputDirArg] = process.argv;

  if (!logFileArg) {
    console.error('Usage: node dist/scripts/extract-provider-traffic.js <log-file> [output-dir]');
    process.exit(1);
  }

  const logFile = path.resolve(logFileArg);
  const outputDir = outputDirArg
    ? path.resolve(outputDirArg)
    : path.resolve(`${logFileArg.replace(/\.log$/i, '')}.provider-traffic`);

  const content = await fs.readFile(logFile, 'utf8');
  const records = extractProviderTrafficFromLogContent(content);
  const result = await writeProviderTrafficFiles(records, outputDir);

  console.log(
    [
      `Extracted provider traffic`,
      `  log file: ${logFile}`,
      `  output dir: ${outputDir}`,
      `  traces: ${result.traces}`,
      `  files: ${result.files}`,
      `  index: ${result.indexPath}`,
    ].join('\n'),
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to extract provider traffic: ${message}`);
  process.exit(1);
});
