import { parentPort } from 'node:worker_threads';
import { SessionIndexDatabase } from './session-index-database.js';

export type WorkerRequestPayload =
  | { type: 'init'; dbPath: string; sourceDirectory: string }
  | { type: 'probe' }
  | { type: 'reconcile' }
  | { type: 'list'; options: { projectPath: string; sshHost?: string } }
  | {
      type: 'resolve';
      reference: string;
      options: { projectPath: string; sshHost?: string; currentSessionId?: string };
    }
  | { type: 'get_revision'; sessionId: string }
  | {
      type: 'read_session';
      sessionId: string;
      options: { projectPath: string; sshHost?: string };
    }
  | {
      type: 'search';
      options: { query: string; projectPath: string; sshHost?: string };
    }
  | { type: 'close' };

export type WorkerRequest = { id: number } & WorkerRequestPayload;

export type WorkerResponse = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };

export function runSessionIndexWorker(): void {
  if (!parentPort) {
    throw new Error('runSessionIndexWorker must be called in a worker thread with parentPort');
  }

  let db: SessionIndexDatabase | null = null;

  parentPort.on('message', (msg: WorkerRequest) => {
    if (!msg || typeof msg !== 'object' || typeof msg.id !== 'number') return;

    try {
      switch (msg.type) {
        case 'init': {
          if (db) db.close();
          db = new SessionIndexDatabase(msg.dbPath, msg.sourceDirectory);
          parentPort!.postMessage({ id: msg.id, ok: true, result: { initialized: true } } satisfies WorkerResponse);
          break;
        }

        case 'probe': {
          if (!db) throw new Error('Database not initialized');
          const result = db.probeCapability();
          parentPort!.postMessage({ id: msg.id, ok: true, result } satisfies WorkerResponse);
          break;
        }

        case 'reconcile': {
          if (!db) throw new Error('Database not initialized');
          const result = db.reconcile();
          parentPort!.postMessage({ id: msg.id, ok: true, result } satisfies WorkerResponse);
          break;
        }

        case 'list': {
          if (!db) throw new Error('Database not initialized');
          const result = db.list(msg.options);
          parentPort!.postMessage({ id: msg.id, ok: true, result } satisfies WorkerResponse);
          break;
        }

        case 'resolve': {
          if (!db) throw new Error('Database not initialized');
          const result = db.resolveReference(msg.reference, msg.options);
          parentPort!.postMessage({ id: msg.id, ok: true, result } satisfies WorkerResponse);
          break;
        }

        case 'get_revision': {
          if (!db) throw new Error('Database not initialized');
          const result = db.getRevision(msg.sessionId);
          parentPort!.postMessage({ id: msg.id, ok: true, result } satisfies WorkerResponse);
          break;
        }

        case 'read_session': {
          if (!db) throw new Error('Database not initialized');
          const result = db.readSession(msg.sessionId, msg.options);
          parentPort!.postMessage({ id: msg.id, ok: true, result } satisfies WorkerResponse);
          break;
        }

        case 'search': {
          if (!db) throw new Error('Database not initialized');
          const result = db.search(msg.options);
          parentPort!.postMessage({ id: msg.id, ok: true, result } satisfies WorkerResponse);
          break;
        }

        case 'close': {
          if (db) {
            db.close();
            db = null;
          }
          parentPort!.postMessage({ id: msg.id, ok: true, result: { closed: true } } satisfies WorkerResponse);
          break;
        }

        default: {
          const exhaustiveCheck: never = msg;
          parentPort!.postMessage({
            id: (exhaustiveCheck as WorkerRequest).id,
            ok: false,
            error: `Unknown worker request type: ${(exhaustiveCheck as WorkerRequest).type}`,
          } satisfies WorkerResponse);
        }
      }
    } catch (error) {
      parentPort!.postMessage({
        id: msg.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      } satisfies WorkerResponse);
    }
  });
}
