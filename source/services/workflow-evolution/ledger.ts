import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { applyEvent, eventSchema, type Experiment, type ExperimentEvent } from './experiment.js';

const logSchema = z.object({ format: z.literal(1), events: z.array(eventSchema).min(1) }).strict();

async function readEvents(file: string): Promise<ExperimentEvent[]> {
  try {
    return logSchema.parse(JSON.parse(await readFile(file, 'utf8'))).events;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

function replay(events: ExperimentEvent[]): Experiment | null {
  return events.reduce<Experiment | null>((state, event) => applyEvent(state, event), null);
}

export async function readLedger(file: string): Promise<Experiment> {
  const state = replay(await readEvents(file));
  if (!state) throw new Error('Experiment does not exist');
  return state;
}

/** Serialized local writes; failed validation leaves the previous log intact. */
export async function appendEvent(file: string, input: unknown): Promise<Experiment> {
  const event = eventSchema.parse(input);
  await mkdir(dirname(file), { recursive: true });
  // A crashed writer leaves a visible lock. Never steal it on a time heuristic.
  const lockPath = `${file}.lock`;
  const lock = await open(lockPath, 'wx', 0o600);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const events = await readEvents(file);
    const state = applyEvent(replay(events), event);
    const output = await open(temporary, 'wx', 0o600);
    try {
      await output.writeFile(JSON.stringify({ format: 1, events: [...events, event] }, null, 2) + '\n');
      await output.sync();
    } finally {
      await output.close();
    }
    await rename(temporary, file);
    return state;
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    await lock.close();
    await unlink(lockPath);
  }
}
