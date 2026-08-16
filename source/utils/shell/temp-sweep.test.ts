import { describe, it, expect, vi } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { isPidAlive, parseTempArtifactMeta, pruneStaleTempArtifacts } from './temp-sweep.js';

describe('temp-sweep', () => {
  describe('isPidAlive', () => {
    it('returns true for the current process PID', () => {
      expect(isPidAlive(process.pid)).toBe(true);
    });

    it('returns false for an invalid or non-existent PID', () => {
      expect(isPidAlive(-1)).toBe(false);
      expect(isPidAlive(0)).toBe(false);
      expect(isPidAlive(NaN)).toBe(false);
      // Large unallocated PID
      expect(isPidAlive(99999999)).toBe(false);
    });
  });

  describe('parseTempArtifactMeta', () => {
    it('parses valid artifact filename', () => {
      const meta = parseTempArtifactMeta('output-12345-1718000000000-abcdef.txt');
      expect(meta).toEqual({
        prefix: 'output',
        pid: 12345,
        timestamp: 1718000000000,
        suffix: 'abcdef',
      });
    });

    it('parses subagent result filename', () => {
      const meta = parseTempArtifactMeta('result-9876-1719000000000-123456.md');
      expect(meta).toEqual({
        prefix: 'result',
        pid: 9876,
        timestamp: 1719000000000,
        suffix: '123456',
      });
    });

    it('returns null for unformatted filenames', () => {
      expect(parseTempArtifactMeta('output-abcdef.txt')).toBeNull();
      expect(parseTempArtifactMeta('something.txt')).toBeNull();
    });
  });

  describe('pruneStaleTempArtifacts', () => {
    async function createTempSandbox() {
      const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'term2-test-sweep-'));
      const toolOutputDir = path.join(baseDir, 'tool-output');
      const subagentResultDir = path.join(baseDir, 'subagent-result');
      await fs.mkdir(toolOutputDir, { recursive: true });
      await fs.mkdir(subagentResultDir, { recursive: true });
      return { baseDir, toolOutputDir, subagentResultDir };
    }

    it('deletes artifacts from dead PIDs after the grace period', async () => {
      const { baseDir, toolOutputDir } = await createTempSandbox();
      const now = Date.now();
      const tenMinutesAgo = now - 10 * 60 * 1000;
      const deadPid = 99999998;
      const livePid = process.pid;

      const deadFile = path.join(toolOutputDir, `output-${deadPid}-${tenMinutesAgo}-abcdef.txt`);
      const liveFile = path.join(toolOutputDir, `output-${livePid}-${tenMinutesAgo}-123456.txt`);
      await fs.writeFile(deadFile, 'dead payload');
      await fs.writeFile(liveFile, 'live payload');

      await pruneStaleTempArtifacts({
        baseTempDir: baseDir,
        systemTmpDir: baseDir,
        now,
        deadPidGracePeriodMs: 5 * 60 * 1000,
        checkPidAlive: (pid) => pid === livePid,
      });

      const remaining = await fs.readdir(toolOutputDir);
      expect(remaining).not.toContain(path.basename(deadFile));
      expect(remaining).toContain(path.basename(liveFile));

      await fs.rm(baseDir, { recursive: true, force: true });
    });

    it('spares artifacts from dead PIDs within the grace period', async () => {
      const { baseDir, toolOutputDir } = await createTempSandbox();
      const now = Date.now();
      const twoMinutesAgo = now - 2 * 60 * 1000;
      const deadPid = 99999998;

      const recentDeadFile = path.join(toolOutputDir, `output-${deadPid}-${twoMinutesAgo}-abcdef.txt`);
      await fs.writeFile(recentDeadFile, 'recent dead payload');

      await pruneStaleTempArtifacts({
        baseTempDir: baseDir,
        systemTmpDir: baseDir,
        now,
        deadPidGracePeriodMs: 5 * 60 * 1000,
        checkPidAlive: () => false,
      });

      const remaining = await fs.readdir(toolOutputDir);
      expect(remaining).toContain(path.basename(recentDeadFile));

      await fs.rm(baseDir, { recursive: true, force: true });
    });

    it('prunes artifacts older than maxAgeMs even if PID is unknown or alive', async () => {
      const { baseDir, toolOutputDir } = await createTempSandbox();
      const now = Date.now();
      const twoDaysAgo = now - 48 * 60 * 60 * 1000;
      const livePid = process.pid;

      const oldFile = path.join(toolOutputDir, `output-${livePid}-${twoDaysAgo}-abcdef.txt`);
      const legacyFile = path.join(toolOutputDir, 'legacy-output.txt');
      await fs.writeFile(oldFile, 'old payload');
      await fs.writeFile(legacyFile, 'legacy payload');

      // Set old mtime on legacy file
      const oldDate = new Date(twoDaysAgo);
      await fs.utimes(legacyFile, oldDate, oldDate);

      await pruneStaleTempArtifacts({
        baseTempDir: baseDir,
        systemTmpDir: baseDir,
        now,
        maxAgeMs: 24 * 60 * 60 * 1000,
        checkPidAlive: () => true,
      });

      const remaining = await fs.readdir(toolOutputDir);
      expect(remaining).not.toContain(path.basename(oldFile));
      expect(remaining).not.toContain(path.basename(legacyFile));

      await fs.rm(baseDir, { recursive: true, force: true });
    });

    it('prunes stale docker-config and legacy temp directories in system tmp', async () => {
      const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'term2-test-sweep-'));
      const now = Date.now();
      const twoDaysAgo = new Date(now - 48 * 60 * 60 * 1000);

      const staleDockerDir = path.join(baseDir, 'docker-config-old123');
      const freshDockerDir = path.join(baseDir, 'docker-config-fresh123');
      const legacyToolDir = path.join(baseDir, 'term2-tool-output-old456');

      await fs.mkdir(staleDockerDir, { recursive: true });
      await fs.mkdir(freshDockerDir, { recursive: true });
      await fs.mkdir(legacyToolDir, { recursive: true });

      await fs.utimes(staleDockerDir, twoDaysAgo, twoDaysAgo);
      await fs.utimes(legacyToolDir, twoDaysAgo, twoDaysAgo);

      await pruneStaleTempArtifacts({
        baseTempDir: baseDir,
        systemTmpDir: baseDir,
        now,
        maxAgeMs: 24 * 60 * 60 * 1000,
      });

      const remaining = await fs.readdir(baseDir);
      expect(remaining).not.toContain('docker-config-old123');
      expect(remaining).toContain('docker-config-fresh123');
      expect(remaining).not.toContain('term2-tool-output-old456');

      await fs.rm(baseDir, { recursive: true, force: true });
    });
  });
});
