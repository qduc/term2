import fs from 'node:fs';
import path from 'node:path';
import { projectMemoryId } from './isolation.mjs';

export function seedMemoryStore(root, memories, timestamp = '2026-01-15T00:00:00.000Z') {
  fs.mkdirSync(path.join(root, 'items'), { recursive: true });
  const index = {
    version: 1,
    memories: memories.map((memory) => ({
      id: memory.id,
      title: memory.title,
      summary: memory.summary,
      tags: memory.tags ?? [],
      createdAt: timestamp,
      updatedAt: timestamp,
    })),
  };
  fs.writeFileSync(path.join(root, 'index.json'), JSON.stringify(index, null, 2) + '\n');
  for (const memory of memories) {
    fs.writeFileSync(path.join(root, 'items', memory.id + '.md'), memory.content);
  }
}

export function seedProjectAndGlobalMemory({ memoryDirectory, workspacePath, projectMemories, globalMemories }) {
  const projectId = projectMemoryId(workspacePath);
  seedMemoryStore(memoryDirectory, globalMemories);
  seedMemoryStore(path.join(memoryDirectory, 'projects', projectId), projectMemories);
  return projectId;
}
