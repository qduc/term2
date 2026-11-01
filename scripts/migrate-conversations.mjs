#!/usr/bin/env node
// Standalone offline command: deliberately does not import the product CLI/app.
import process from 'node:process';
import { parseMigrationArguments, runMigration } from './conversation-migration/migration-command.mjs';

try {
  const report = await runMigration(parseMigrationArguments(process.argv.slice(2)));
  process.stdout.write(JSON.stringify(report) + '\n');
  if (report.counts.failed || report.counts.skipped) process.exitCode = 2;
} catch {
  process.stdout.write(JSON.stringify({ codes: { COMMAND_REFUSED: 1 } }) + '\n');
  process.exitCode = 1;
}
