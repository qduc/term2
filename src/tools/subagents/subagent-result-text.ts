import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SANDBOX_TEMP_DIR } from '../../shared/utils/shell/temp-dir.js';
import type { SubagentResult } from './types.js';

const MAX_FINAL_TEXT_CHARS = 40_000;
const SUBAGENT_RESULT_DIR = path.join(SANDBOX_TEMP_DIR, 'subagent-result');
let subagentResultTempDirPromise: Promise<string> | undefined;

export async function truncateResultText(
  text: string,
): Promise<Pick<SubagentResult, 'finalText' | 'finalTextTruncated' | 'finalTextArtifactPath'>> {
  if (text.length <= MAX_FINAL_TEXT_CHARS) return { finalText: text };

  const artifactPath = await saveSubagentResultArtifact(text);
  return {
    finalText:
      text.slice(0, MAX_FINAL_TEXT_CHARS) + `\n...(truncated)\nFull subagent result saved to \`${artifactPath}\``,
    finalTextTruncated: true,
    finalTextArtifactPath: artifactPath,
  };
}

async function saveSubagentResultArtifact(text: string): Promise<string> {
  subagentResultTempDirPromise ??= (async () => {
    await mkdir(SUBAGENT_RESULT_DIR, { recursive: true, mode: 0o700 });
    return SUBAGENT_RESULT_DIR;
  })();
  const tempDir = await subagentResultTempDirPromise;
  const suffix = randomBytes(3).toString('hex');
  const artifactPath = path.join(tempDir, `result-${process.pid}-${Date.now()}-${suffix}.md`);
  await writeFile(artifactPath, text, 'utf8');
  return artifactPath;
}
