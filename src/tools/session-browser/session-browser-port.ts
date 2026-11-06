/** Transcript kinds exposed by the browser tool protocol, not persistence event types. */
export type Kind = 'user' | 'assistant' | 'reasoning' | 'system' | 'tool' | 'subagent';

export type SessionListInput = { limit?: number; maxChars?: number };
export type SessionSearchInput = { query: string; kinds?: Kind[]; limit?: number; maxChars?: number };
export type SessionReadInput = {
  id: string;
  cursor?: string;
  from?: 'end';
  index?: number;
  before?: number;
  kinds?: Kind[];
  itemMaxChars?: number;
  limit?: number;
  maxChars?: number;
};

/** Read-only query capability. Results retain the tool's existing runtime envelope schemas.
 * No persistence, index lifecycle, or session mutation authority is exposed to tools.
 */
export interface SessionBrowserPort {
  list(input: SessionListInput): unknown | Promise<unknown>;
  search(input: SessionSearchInput): unknown | Promise<unknown>;
  read(input: SessionReadInput): unknown | Promise<unknown>;
}
