/**
 * Explicit, read-only review of possible durable knowledge in local sessions.
 * No model call, vector index, network request, or memory write.
 *
 * ./node_modules/.bin/tsx scripts/session-knowledge-candidates.ts [project-path] [--ssh-host host] [--query 'topic']
 * Output is JSON Lines (one candidate per line); inspect its session with
 * session_read({ id: sessionId, index: sourceIndex, before: 2 }) before saving anything.
 */
import path from 'node:path';
import { scanSessionKnowledgeCandidates } from '../source/services/conversation/session-knowledge-candidates.js';

const args = process.argv.slice(2);
const queryFlag = args.indexOf('--query');
let query: string | undefined;
if (queryFlag !== -1) {
  query = args[queryFlag + 1];
  if (!query || query.startsWith('--') || !/[a-z0-9]/i.test(query)) throw new Error('--query needs words');
  args.splice(queryFlag, 2);
}
const sshFlag = args.indexOf('--ssh-host');
let sshHost: string | undefined;
if (sshFlag !== -1) {
  sshHost = args[sshFlag + 1];
  if (!sshHost || sshHost.startsWith('--')) throw new Error('--ssh-host needs a host');
  args.splice(sshFlag, 2);
}
if (args.length > 1 || args[0]?.startsWith('--')) {
  throw new Error('Usage: session-knowledge-candidates.ts [project-path] [--ssh-host host] [--query topic]');
}
const projectPath = path.resolve(args[0] ?? process.cwd());
const { candidates, unavailable } = scanSessionKnowledgeCandidates(projectPath, sshHost, query);
for (const candidate of candidates) console.log(JSON.stringify(candidate));
console.error(`Review only: ${candidates.length} leads, ${unavailable} unavailable logs; no memories saved.`);
