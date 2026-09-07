import fs from 'node:fs';

export function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const text = fs.readFileSync(filePath, 'utf8');
  return text
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

export function conversationEvents(filePath) {
  return readJsonl(filePath)
    .map((row) => row.event ?? row)
    .filter((event) => event && typeof event.type === 'string');
}
