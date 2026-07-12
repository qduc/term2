import type { ISettingsService } from '../service-interfaces.js';
import { FileMemoryStore } from './memory-store.js';
import { createMemoryToolDefinitions } from '../../tools/memory/memory-tools.js';
import type { ToolDefinition } from '../../tools/types.js';

export type MemoryAccess = 'none' | 'read' | 'write';

export type MemoryCapabilitySubject = { kind: 'main' } | { kind: 'subagent'; role: string };

export type MemoryCapability = {
  access: MemoryAccess;
  tools: ToolDefinition[];
  guidance: string;
  context: string;
};

type MemorySettings = {
  enabled: boolean;
  directory: string;
  contextBudgetChars: number;
  searchDefaultLimit: number;
  searchMaxLimit: number;
};

const READ_TOOL_COUNT = 3;

const MAIN_GUIDANCE = `### Persistent memory

You have access to persistent memory from previous sessions. The initial memory list contains summaries only; load full memories selectively when relevant.

Validate any memory proposals from subagents before acting on them. Persist only durable, useful information, and merge or update an existing memory rather than creating a duplicate when appropriate. Do not store temporary task state, intermediate reasoning, ordinary conversation details, duplicates, secrets, or sensitive data unless the user explicitly requests persistence.`;

const SUBAGENT_GUIDANCE = `### Persistent memory

You can read persistent memory from previous sessions, but cannot change it. Search memory only when it is materially useful to the task; treat results as potentially stale and avoid unnecessary repetition.

If you discover durable, reusable knowledge worth retaining, propose it in your final report for the main agent to review and persist. Never claim a proposal was persisted. Use this concise structure: action, target, reason, content, evidence.`;

/**
 * Resolves the complete memory authority for a caller. This is the sole place
 * that maps roles to authority and couples memory settings, store creation,
 * tool filtering, prompt guidance, and injected context.
 */
export class MemoryCapabilityBuilder {
  #settings: ISettingsService;

  constructor(settings: ISettingsService) {
    this.#settings = settings;
  }

  build(subject: MemoryCapabilitySubject): MemoryCapability {
    const access = this.#accessFor(subject);
    const settings = this.#settings.get<MemorySettings>('memory');
    if (access === 'none' || !settings?.enabled) {
      return { access: 'none', tools: [], guidance: '', context: '' };
    }

    const store = this.#createStore(settings);
    const tools = createMemoryToolDefinitions(store);
    return {
      access,
      tools: access === 'read' ? tools.slice(0, READ_TOOL_COUNT) : tools,
      guidance: subject.kind === 'main' ? MAIN_GUIDANCE : SUBAGENT_GUIDANCE,
      // Read-only subagents search selectively on demand; only main agents
      // receive the automatic summary context.
      context: access === 'write' ? store.contextSync(settings.contextBudgetChars) : '',
    };
  }

  #accessFor(subject: MemoryCapabilitySubject): MemoryAccess {
    if (subject.kind === 'main') return 'write';
    return ['explorer', 'worker', 'researcher'].includes(subject.role) ? 'read' : 'none';
  }

  #createStore(settings: MemorySettings): FileMemoryStore {
    return new FileMemoryStore({
      root: settings.directory,
      searchDefaultLimit: settings.searchDefaultLimit,
      searchMaxLimit: settings.searchMaxLimit,
    });
  }
}
