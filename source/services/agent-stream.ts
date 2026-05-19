export type AgentStream = AsyncIterable<unknown> & {
  completed: Promise<unknown>;
  rawResponses?: unknown[];
  lastResponseId?: string | null;
  interruptions?: unknown[];
  state?: unknown;
  newItems?: unknown[];
  history?: unknown[];
  finalOutput?: string;
  cancelled?: boolean;
};
