import fs from 'node:fs';
import path from 'node:path';
import { GatewayPersistenceError } from './contracts.js';
import { fsyncDirectory } from './storage.js';
import { sanitizePendingInteractionDto } from '../interaction-protocol.js';
export class InteractionCheckpointStore {
    #path;
    #checkpoint = null;
    constructor(directory) {
        this.#path = path.join(directory, 'interaction-checkpoint.json');
        if (fs.existsSync(this.#path)) {
            try {
                const value = JSON.parse(fs.readFileSync(this.#path, 'utf8'));
                if (!value.turnId || !value.generation || !value.interaction)
                    throw new Error();
                this.#checkpoint = Object.freeze({
                    ...value,
                    interaction: sanitizePendingInteractionDto(value.interaction),
                });
            }
            catch {
                throw new GatewayPersistenceError('corrupt', 'interaction checkpoint is corrupt');
            }
        }
    }
    get current() {
        return this.#checkpoint;
    }
    save(checkpoint) {
        const safeCheckpoint = {
            ...checkpoint,
            interaction: sanitizePendingInteractionDto(checkpoint.interaction),
        };
        const temporary = `${this.#path}.${process.pid}.tmp`;
        fs.writeFileSync(temporary, JSON.stringify(safeCheckpoint) + '\n', { mode: 0o600 });
        const fd = fs.openSync(temporary, 'r');
        try {
            fs.fsyncSync(fd);
        }
        finally {
            fs.closeSync(fd);
        }
        fs.renameSync(temporary, this.#path);
        fsyncDirectory(path.dirname(this.#path));
        this.#checkpoint = Object.freeze({
            ...safeCheckpoint,
        });
    }
    clear() {
        try {
            fs.unlinkSync(this.#path);
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw error;
        }
        this.#checkpoint = null;
    }
    async recover(journal) {
        const checkpoint = this.#checkpoint;
        if (!checkpoint)
            return;
        await journal.append({
            sessionId: journal.sessionId,
            type: 'interaction_recovered',
            payload: {
                turnId: checkpoint.turnId,
                interaction: sanitizePendingInteractionDto(checkpoint.interaction),
                reason: 'daemon_restart',
            },
        }, { durability: 'critical' });
        if (checkpoint.settleOnRecovery === 'child_interrupted') {
            await journal.append({
                sessionId: journal.sessionId,
                type: 'interaction_resolved',
                payload: {
                    turnId: checkpoint.turnId,
                    interactionId: checkpoint.interaction.interactionId,
                    outcome: 'cancelled',
                    variant: checkpoint.interaction.variant,
                },
            }, { durability: 'critical' });
            await journal.append({
                sessionId: journal.sessionId,
                type: 'subagent_interrupted',
                payload: {
                    turnId: checkpoint.turnId,
                    agentId: checkpoint.child?.agentId ?? checkpoint.interaction.descriptor.agentName,
                    role: checkpoint.child?.role ?? checkpoint.interaction.descriptor.agentName,
                    finalText: 'Child interaction interrupted by daemon restart.',
                },
            }, { durability: 'critical' });
        }
        this.clear();
    }
}
//# sourceMappingURL=interaction-checkpoint.js.map