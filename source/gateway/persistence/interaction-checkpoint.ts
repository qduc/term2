import fs from 'node:fs';
import path from 'node:path';
import type { GatewayEventJournalImpl } from './event-journal.js';
import { GatewayPersistenceError } from './contracts.js';
import { fsyncDirectory } from './storage.js';
import { sanitizePendingInteractionDto, type PendingInteractionDto } from '../interaction-protocol.js';

export type InteractionCheckpoint = {
  readonly turnId: string;
  readonly interaction: PendingInteractionDto;
  readonly revision: number;
  readonly generation: string;
};

export class InteractionCheckpointStore {
  readonly #path: string;
  #checkpoint: InteractionCheckpoint | null = null;

  constructor(directory: string) {
    this.#path = path.join(directory, 'interaction-checkpoint.json');
    if (fs.existsSync(this.#path)) {
      try {
        const value = JSON.parse(fs.readFileSync(this.#path, 'utf8')) as InteractionCheckpoint;
        if (!value.turnId || !value.generation || !value.interaction) throw new Error();
        this.#checkpoint = Object.freeze({
          ...value,
          interaction: sanitizePendingInteractionDto(value.interaction),
        });
      } catch {
        throw new GatewayPersistenceError('corrupt', 'interaction checkpoint is corrupt');
      }
    }
  }

  get current(): InteractionCheckpoint | null {
    return this.#checkpoint;
  }

  save(checkpoint: InteractionCheckpoint): void {
    const safeCheckpoint: InteractionCheckpoint = {
      ...checkpoint,
      interaction: sanitizePendingInteractionDto(checkpoint.interaction),
    };
    const temporary = `${this.#path}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(safeCheckpoint) + '\n', { mode: 0o600 });
    const fd = fs.openSync(temporary, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, this.#path);
    fsyncDirectory(path.dirname(this.#path));
    this.#checkpoint = Object.freeze({
      ...safeCheckpoint,
    });
  }

  clear(): void {
    try {
      fs.unlinkSync(this.#path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.#checkpoint = null;
  }

  async recover(journal: GatewayEventJournalImpl): Promise<void> {
    const checkpoint = this.#checkpoint;
    if (!checkpoint) return;
    await journal.append(
      {
        sessionId: journal.sessionId,
        type: 'interaction_recovered',
        payload: {
          turnId: checkpoint.turnId,
          interaction: sanitizePendingInteractionDto(checkpoint.interaction),
          reason: 'daemon_restart',
        },
      },
      { durability: 'critical' },
    );
    this.clear();
  }
}
