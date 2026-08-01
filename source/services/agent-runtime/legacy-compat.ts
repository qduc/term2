import type { ApplicationAgent } from './application-run-loop.js';
import type { ToolDefinition } from '../../tools/types.js';
import { normalizeToolInput } from '../../lib/tool-invoke.js';

export class RunContext<T = unknown> {
  #approvals: Record<
    string,
    {
      approved: boolean | string[];
      rejected: boolean | string[];
      messages?: Record<string, string>;
      stickyRejectMessage?: string;
    }
  > = {};
  constructor(public context: T) {}
  toJSON(): any {
    return { context: this.context, approvals: structuredClone(this.#approvals) };
  }
  approveTool(item: any, options: { alwaysApprove?: boolean } = {}): void {
    const tool = item?.toolName ?? item?.rawItem?.name;
    const callId = item?.rawItem?.callId ?? item?.callId;
    const current = this.#approvals[tool] ?? { approved: [], rejected: [] };
    current.approved = options.alwaysApprove
      ? true
      : [...(Array.isArray(current.approved) ? current.approved : []), callId];
    this.#approvals[tool] = current;
  }
  rejectTool(item: any, options: { alwaysReject?: boolean; message?: string } = {}): void {
    const tool = item?.toolName ?? item?.rawItem?.name;
    const callId = item?.rawItem?.callId ?? item?.callId;
    const current = this.#approvals[tool] ?? { approved: [], rejected: [] };
    current.rejected = options.alwaysReject
      ? true
      : [...(Array.isArray(current.rejected) ? current.rejected : []), callId];
    if (options.message) current.messages = { ...(current.messages ?? {}), [callId]: options.message };
    if (options.alwaysReject && options.message) current.stickyRejectMessage = options.message;
    this.#approvals[tool] = current;
  }
  isToolApproved(input: { toolName: string; callId: string }): boolean | undefined {
    const record = this.#approvals[input.toolName];
    if (!record) return undefined;
    if (record.approved === true) return true;
    if (record.rejected === true) return false;
    if (Array.isArray(record.approved) && record.approved.includes(input.callId)) return true;
    if (Array.isArray(record.rejected) && record.rejected.includes(input.callId)) return false;
    return undefined;
  }
  getRejectionMessage(toolName: string, callId: string): string | undefined {
    const record = this.#approvals[toolName];
    return record?.messages?.[callId] ?? record?.stickyRejectMessage;
  }
}
export type Tool<T = unknown> = ToolDefinition<T> & {
  type: 'function';
  invoke: (context: RunContext<T>, input: unknown, details?: unknown) => Promise<unknown>;
};
type ToolFactoryConfig = {
  name?: string;
  description?: string;
  parameters?: any;
  needsApproval?: (params: any, context?: RunContext<any>) => Promise<boolean> | boolean;
  execute?: (params: any, context?: RunContext<any>, details?: any) => Promise<any> | any;
  [key: string]: unknown;
};

export class Agent<T = unknown> implements ApplicationAgent {
  readonly name: string;
  readonly instructions: string;
  readonly model: string;
  readonly modelSettings: any;
  readonly tools: readonly any[];
  readonly outputType: any;
  readonly handoffs: readonly unknown[] = [];
  readonly mcpServers: readonly unknown[] = [];
  readonly mcpConfig: Record<string, unknown> = {};
  defaultRunOptions: any;
  constructor(config: any) {
    Object.assign(this, config);
    this.name = config.name;
    this.instructions = typeof config.instructions === 'string' ? config.instructions : '';
    this.model = config.model ?? '';
    this.modelSettings = config.modelSettings ?? {};
    this.tools = config.tools ?? [];
    this.outputType = config.outputType;
  }
  clone(overrides: any = {}): Agent<T> {
    return new Agent<T>({ ...this, ...overrides });
  }
  asTool(config: any): Tool<T> {
    return tool({
      name: config.toolName,
      description: config.toolDescription,
      parameters: config.parameters,
      execute: async (params: any, context: RunContext<T> | undefined, details: any) => {
        const input = config.inputBuilder ? config.inputBuilder({ params, context, details }) : params;
        if (config.run) return config.run(input, context, details);
        return input;
      },
    });
  }
}

export function tool(config: ToolFactoryConfig): Tool {
  const definition: any = {
    ...config,
    type: 'function',
    parameters: config.parameters,
    needsApproval: config.needsApproval ?? (() => false),
    execute: config.execute ?? (async () => undefined),
  };
  definition.invoke = async (context: RunContext, input: unknown, details?: unknown) => {
    const json = normalizeToolInput(input, config.parameters, (config as any).argumentParsing ?? 'strict');
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch (error) {
      throw Object.assign(error as Error, { name: 'InvalidToolInputError' });
    }
    if (config.parameters?.safeParse && !config.parameters.safeParse(parsed).success) {
      throw Object.assign(new Error('Invalid tool input'), { name: 'InvalidToolInputError' });
    }
    return definition.execute(parsed, context, details);
  };
  return definition;
}
