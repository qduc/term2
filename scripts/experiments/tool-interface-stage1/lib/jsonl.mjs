import fs from 'node:fs';

export function parseJsonlText(text) {
  return String(text || '')
    .split('\n')
    .filter((line) => line.trim())
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

export function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return parseJsonlText(fs.readFileSync(filePath, 'utf8'));
}

export function conversationEvents(filePath) {
  return readJsonl(filePath)
    .map((row) => row.event ?? row)
    .filter((event) => event && typeof event.type === 'string');
}

export function stdoutEvents(stdout) {
  return parseJsonlText(stdout).filter((event) => event && typeof event.type === 'string');
}
