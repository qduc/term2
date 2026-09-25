import { browseConversationsForProject } from './conversation-persistence.js';
import { isBrowsableSession, projectMessages, sessionUpdatedAt } from './session-browser.js';

export type KnowledgeCandidate = {
  category: 'preference' | 'decision' | 'correction' | 'topic_match';
  quote: string;
  sessionId: string;
  /** Session start, not the time the user sent this particular turn. */
  sessionCreatedAt: string;
  /** Index in the session_read projection, usable to inspect surrounding context. */
  sourceIndex: number;
};

// High-precision *leads*, not facts. Short standalone first-person statements
// avoid matching quoted transcripts, code fences and assistant/tool instructions.
function categoryFor(text: string): Exclude<KnowledgeCandidate['category'], 'topic_match'> | null {
  if (text.length > 280 || text !== text.trim() || /[\r\n`]/.test(text) || text.includes('?')) return null;
  if (/^(?:Actually,? |No,? )(?:I prefer|we decided|I meant)\b/i.test(text)) return 'correction';
  if (/^(?:I prefer|I like|I always|I never|Please (?:always|never|don't|do not))\b/i.test(text)) return 'preference';
  if (/^(?:We decided (?:to|on|that)|The decision is)\b/i.test(text)) return 'decision';
  return null;
}

/** Read-only, local review leads from canonical sessions in one project/SSH scope. */
export function scanSessionKnowledgeCandidates(projectPath: string, sshHost?: string, query?: string) {
  const terms = query?.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const browsed = browseConversationsForProject(projectPath, sshHost);
  const candidates: KnowledgeCandidate[] = [];
  let unavailable = browsed.unavailable;
  for (const conversation of browsed.conversations.sort(
    (a, b) => sessionUpdatedAt(b).localeCompare(sessionUpdatedAt(a)) || a.id.localeCompare(b.id),
  )) {
    const projection = projectMessages(conversation);
    if (!isBrowsableSession(conversation) || !projection) {
      unavailable++;
      continue;
    }
    for (const record of projection.records) {
      if (record.kind !== 'user') continue;
      const category = categoryFor(record.text);
      // An explicit topic query also returns short, standalone user evidence
      // even when its wording does not match a conservative memory pattern.
      if (!category && !terms.length) continue;
      if (record.text.length > 280 || /[\r\n]/.test(record.text)) continue;
      if (terms.length) {
        const words = new Set(record.text.toLowerCase().match(/[a-z0-9]+/g) ?? []);
        if (!terms.every((term) => words.has(term))) continue;
      }
      candidates.push({
        category: category ?? 'topic_match',
        quote: record.text,
        sessionId: conversation.id,
        sessionCreatedAt: conversation.createdAt,
        sourceIndex: record.index,
      });
    }
  }
  return { candidates, unavailable };
}
