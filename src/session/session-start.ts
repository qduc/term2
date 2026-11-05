import { resolve } from 'node:path';
import type { SessionStartedFact } from './facts.js';
import { directLogPath, discoverDirectLogs, readDirectLogHeaderLine } from './rolling-log.js';

/**
 * The logical Session's start fact, from the first line of its root file: no body is parsed.
 * `id` may be any physical file of the lineage. For callers that only need to know whose session it is.
 */
export function readDirectSessionStart(
  directory: string,
  id: string,
): { readonly logicalSessionId: string; readonly metadata: SessionStartedFact } {
  directory = resolve(directory);
  directLogPath(directory, id);
  const { headers, errors } = discoverDirectLogs(directory);
  let rootId = id;
  for (const seen = new Set<string>(); ; ) {
    if (seen.has(rootId)) throw new Error('cycle in direct Session log lineage');
    seen.add(rootId);
    const error = errors.get(rootId);
    if (error) throw error;
    const header = headers.get(rootId);
    if (!header) throw new Error(`direct log ${rootId} has no accepted first line`);
    if (header.type === 'session_started') break;
    rootId = header.predecessor.sessionId;
  }
  const bytes = readDirectLogHeaderLine(directLogPath(directory, rootId));
  const fact = bytes ? (JSON.parse(bytes.toString('utf8')).fact as SessionStartedFact) : undefined;
  if (fact?.type !== 'session_started' || fact.id !== rootId)
    throw new Error('direct lineage has invalid logical Session metadata');
  return { logicalSessionId: rootId, metadata: fact };
}
