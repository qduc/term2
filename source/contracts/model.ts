/**
 * Application-owned model protocol.
 *
 * Provider-specific request and response items remain opaque until their
 * owning provider contract is migrated; decorators only need this boundary.
 */
export type ModelRequest = {
  systemInstructions?: string;
  input: unknown;
  previousResponseId?: string;
  conversationId?: string;
  modelSettings: any;
  tools: any[];
  toolsExplicitlyProvided?: boolean;
  outputType: any;
  handoffs: any[];
  tracing: any;
  signal?: AbortSignal;
  prompt?: any;
  overridePromptModel?: boolean;
};

export type ModelResponse = {
  usage: any;
  output: any[];
  responseId?: string;
  requestId?: string;
  providerData?: Record<string, any>;
};

export type StreamEvent = any;

export interface Model {
  getResponse(request: ModelRequest): Promise<ModelResponse>;
  getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent>;
  close?(): Promise<void>;
}

/** Compatibility provider shape; its returned legacy model is intentionally opaque. */
export interface LegacyModelProvider {
  getModel(modelName?: string): LegacyModel | Promise<LegacyModel>;
}

/** Structural legacy model shape used only at compatibility boundaries. */
export interface LegacyModel {
  getResponse(request: any): Promise<any>;
  getStreamedResponse(request: any): AsyncIterable<any>;
  close?(): Promise<void>;
}

/** Compatibility runner shape used only until the legacy loop is retired. */
export interface LegacyRunner {
  readonly config: any;
  run(agent: unknown, input: unknown, options?: unknown): Promise<any>;
}
