export interface SavedMessage {
  id: string;
  sender: string;
  text?: string;
  [key: string]: unknown;
}

export interface SavedAppMode {
  mentorMode: boolean;
  liteMode: boolean;
  planMode: boolean;
  /** Optional: absent in saves from before orchestrator mode was introduced. Treat undefined as false. */
  orchestratorMode?: boolean;
}
