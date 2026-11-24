import type { SettingsProjection } from '../../../lib/term2/types';
import type { SettingItem, SettingOption } from './settings-catalog';

/**
 * Rows that bring the TUI's Permissions, Tools, Context and Models settings to the web page.
 * `settings-catalog.ts` places each group within its section.
 */

const isOn = (key: string) => (projection: SettingsProjection) =>
  projection.settings.safeDefaults[key]?.value === true;

const RESTART = 'Takes effect after term2 restarts.';

const EFFORT_OPTIONS: SettingOption[] = [
  { value: 'none', label: 'Off' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' },
];

/** Approvals and safety → Sandbox. */
export const PERMISSION_ITEMS: SettingItem[] = [
  {
    id: 'sandbox.enabled',
    section: 'safety',
    group: 'Sandbox',
    source: 'server',
    kind: 'boolean',
    label: 'Sandbox',
    keywords: ['isolation', 'confine', 'container', 'protect'],
    description:
      'Run shell commands in read & write folders inside the sandbox. Read-only folders always use it.',
  },
  {
    id: 'sandbox.readPolicy',
    section: 'safety',
    group: 'Sandbox',
    source: 'server',
    kind: 'select',
    label: 'What sandboxed commands can read',
    keywords: ['read policy', 'strict', 'files', 'home'],
    description: 'Which files outside the folder a sandboxed command may read.',
    options: [
      { value: 'standard', label: 'Standard', hint: 'Anything except credential files such as SSH and cloud keys.' },
      { value: 'strict', label: 'Strict', hint: 'Only the folder and system programs; your home folder and system settings are off limits.' },
    ],
    visibleWhen: isOn('sandbox.enabled'),
  },
  {
    id: 'sandbox.allowNetworking',
    section: 'safety',
    group: 'Sandbox',
    source: 'server',
    kind: 'boolean',
    label: 'Network access from the sandbox',
    keywords: ['internet', 'network', 'download', 'domains', 'networking'],
    description:
      'Offer to let a sandboxed command reach a new network address, after you confirm. Off: sandboxed commands stay offline.',
  },
  {
    id: 'shell.unattendedEscapeReview',
    section: 'safety',
    group: 'Sandbox',
    source: 'server',
    kind: 'boolean',
    label: 'Leaving the sandbox in Unattended mode',
    keywords: ['escape', 'unattended', 'outside sandbox', 'reviewer'],
    description:
      'In Unattended mode, let the safety reviewer approve a command that needs to run outside the sandbox. Off: those commands are refused.',
  },
  {
    id: 'sandbox.dockerHostControlProjects',
    section: 'safety',
    group: 'Sandbox',
    source: 'server',
    kind: 'revoke-list',
    label: 'Docker access',
    keywords: ['docker', 'container', 'grant', 'revoke'],
    description: 'Folders you allowed to control Docker on this computer. Remove one to take its access away.',
  },
];

/** Conversation → Context. */
export const CONTEXT_ITEMS: SettingItem[] = [
  {
    id: 'agent.contextCompaction.mode',
    section: 'conversation',
    group: 'Context',
    source: 'server',
    kind: 'select',
    label: 'How compaction summarizes',
    keywords: ['compaction mode', 'native', 'summarizer', 'summary'],
    description: 'Who writes the summary when a long chat is compacted.',
    options: [
      { value: 'auto', label: 'Automatic', hint: 'The provider’s own compaction when it has one, otherwise term2’s.' },
      { value: 'native', label: 'Provider only', hint: 'Only the provider’s own compaction; none when it has none.' },
      { value: 'local', label: 'term2 only', hint: 'Always term2’s summarizer.' },
    ],
    visibleWhen: isOn('agent.contextCompaction.enabled'),
  },
  {
    id: 'agent.sessionRollover.enabled',
    section: 'conversation',
    group: 'Context',
    source: 'server',
    kind: 'boolean',
    label: 'Session rollover reminders',
    keywords: ['rollover', 'new session', 'handoff', 'milestone'],
    description: 'Remind the agent as the context fills up, so it can plan to continue in a fresh session.',
  },
  {
    id: 'agent.sessionRollover.autoBrief',
    section: 'conversation',
    group: 'Context',
    source: 'server',
    kind: 'boolean',
    label: 'Carry the handoff brief over',
    keywords: ['rollover', 'brief', 'handoff'],
    description: 'Pass the agent’s handoff brief into the new session automatically.',
    visibleWhen: isOn('agent.sessionRollover.enabled'),
  },
  {
    id: 'memory.directory',
    section: 'conversation',
    group: 'Context',
    source: 'server',
    kind: 'text',
    label: 'Memory folder',
    keywords: ['memory', 'path', 'directory', 'where'],
    description: `Where personal memory is stored. ${RESTART}`,
    placeholder: 'Default folder',
    visibleWhen: isOn('memory.enabled'),
  },
];

const tool = (id: string, label: string, description: string, keywords: string[]): SettingItem => ({
  id,
  section: 'tools',
  group: 'Tools the agent can use',
  source: 'server',
  kind: 'boolean',
  label,
  keywords: ['tool', 'disable', 'enable', ...keywords],
  description,
});

/** Tools. */
export const TOOL_ITEMS: SettingItem[] = [
  tool('tools.shell.enabled', 'Shell commands', 'Run commands in a terminal.', ['bash', 'terminal', 'command']),
  tool('tools.fileRead.enabled', 'Reading files', 'Read and search files in the folder.', ['read', 'grep', 'search']),
  tool('tools.fileWrite.enabled', 'Editing files', 'Create and change files.', ['write', 'edit', 'patch']),
  tool('tools.web.enabled', 'Web search and fetch', 'Search the web and read pages.', ['internet', 'browse', 'fetch']),
  tool('tools.memory.enabled', 'Memory', 'Save and look up personal memory.', ['remember']),
  tool('tools.sessions.enabled', 'Past chats', 'Look back at earlier chats in this folder.', ['history', 'sessions']),
  tool('tools.skills.enabled', 'Skills', 'Load skills from the skill catalog.', ['skill']),
  tool('tools.subagents.enabled', 'Subagents', 'Hand work to helper agents.', ['delegate', 'agents', 'helpers']),
  tool('tools.backgroundTasks.enabled', 'Background tasks', 'Start and check on long-running tasks.', ['background', 'jobs']),
  tool('tools.mentor.enabled', 'Ask a mentor', 'Ask the mentor models for a second opinion. Needs mentor models set.', [
    'mentor',
    'second opinion',
  ]),
  tool('tools.userInteraction.enabled', 'Ask you questions', 'Pause and ask you a question.', ['ask user', 'question']),
  tool('tools.codeContext.enabled', 'Code context', 'Use code-context tools to understand the codebase.', [
    'code',
    'symbols',
    'index',
  ]),
  {
    id: 'agent.completionVerification',
    section: 'tools',
    group: 'Agent behavior',
    source: 'server',
    kind: 'boolean',
    label: 'Check goals before marking them done',
    keywords: ['verify', 'verification', 'goal', 'completion'],
    description: 'Before a goal counts as achieved, an independent check confirms the work.',
  },
  {
    id: 'agent.backgroundCheckIn.enabled',
    section: 'tools',
    group: 'Agent behavior',
    source: 'server',
    kind: 'boolean',
    label: 'Check in on background work',
    keywords: ['background', 'check in', 'wake', 'poll'],
    description: 'While idle, wake the agent now and then to check on a background command or subagent that is still running.',
  },
  {
    id: 'agent.backgroundCheckIn.intervalMs',
    section: 'tools',
    group: 'Agent behavior',
    source: 'server',
    kind: 'number',
    label: 'Check-in interval',
    keywords: ['background', 'interval', 'how often'],
    description: 'How often to check in.',
    unit: 'min',
    factor: 1 / 60_000,
    min: 1,
    visibleWhen: isOn('agent.backgroundCheckIn.enabled'),
  },
  {
    id: 'enable_agent_workflow',
    section: 'tools',
    group: 'Agent behavior',
    source: 'server',
    kind: 'boolean',
    label: 'Agent workflows',
    keywords: ['workflow', 'parallel', 'concurrent', 'script'],
    description: `Let the agent run small scripts that coordinate several read-only agents at once. ${RESTART}`,
  },
];

/** One row per helper tier: its models below, its reasoning effort (when it has one) on the right. */
const tier = (key: string, label: string, description: string, effortKey?: string): SettingItem => ({
  id: `agent.${key}Model`,
  section: 'models',
  group: 'Helper models',
  source: 'server',
  kind: 'model-tier',
  label,
  keywords: ['tier', 'helper', 'subagent', 'effort', 'thinking', key],
  description,
  keys: [`agent.${key}Model`, ...(effortKey ? [effortKey] : [])],
  max: 8,
  placeholder: 'Uses the chat’s model.',
  options: effortKey ? EFFORT_OPTIONS : undefined,
});

/** Models. */
export const MODEL_ITEMS: SettingItem[] = [
  tier(
    'smart',
    'Smart',
    'The hardest side tasks. Subagents take turns through the list.',
    'agent.smartReasoningEffort',
  ),
  tier('balanced', 'Balanced', 'Everyday side tasks.', 'agent.balancedReasoningEffort'),
  tier('cheap', 'Cheap', 'Simple, high-volume side tasks.', 'agent.cheapReasoningEffort'),
  tier('chore', 'Chore', 'Small background jobs, like reviewing commands in auto-approve mode.'),
  {
    id: 'agent.mentorPool',
    section: 'models',
    group: 'Second opinions',
    source: 'server',
    kind: 'model-pool',
    label: 'Mentor',
    keywords: ['mentor', 'second opinion', 'advice'],
    description: 'Models the agent can ask for a second opinion. Each one answers separately.',
    max: 8,
    placeholder: 'No mentor models.',
  },
  {
    id: 'verifier.model',
    section: 'models',
    group: 'Second opinions',
    source: 'server',
    kind: 'text',
    label: 'Verifier',
    keywords: ['verify', 'verification', 'independent', 'check'],
    description: 'Model ID for independent checks, from the chat’s provider. Leave empty to use the chat’s model.',
    placeholder: 'Same as the chat',
  },
  {
    id: 'agent.favoriteModels',
    section: 'models',
    group: 'Model picker',
    source: 'server',
    kind: 'favorites',
    label: 'Favorites',
    keywords: ['favorite', 'star', 'pinned', 'picker'],
    description: 'Shown first in the model picker.',
  },
  {
    id: 'agent.modelNicknames',
    section: 'models',
    group: 'Model picker',
    source: 'server',
    kind: 'nicknames',
    label: 'Nicknames',
    keywords: ['nickname', 'alias', 'shortcut', '--model'],
    description: 'Short names for models, usable with term2 --model in the terminal.',
  },
  {
    id: 'agent.useFlexServiceTier',
    section: 'models',
    group: 'OpenAI',
    source: 'server',
    kind: 'boolean',
    label: 'Flex tier',
    keywords: ['flex', 'cheaper', 'cost', 'openai', 'slower'],
    description: 'Use OpenAI’s cheaper, slower Flex tier. OpenAI models only.',
  },
];

/** Built-in defaults for the rows above, copied from `src/config/settings/settings-schema.ts`. */
export const PARITY_DEFAULTS: Record<string, unknown> = {
  'sandbox.enabled': true,
  'sandbox.readPolicy': 'standard',
  'sandbox.allowNetworking': true,
  'shell.unattendedEscapeReview': false,
  'sandbox.dockerHostControlProjects': [],
  'agent.contextCompaction.mode': 'auto',
  'agent.sessionRollover.enabled': true,
  'agent.sessionRollover.autoBrief': true,
  'tools.shell.enabled': true,
  'tools.fileRead.enabled': true,
  'tools.fileWrite.enabled': true,
  'tools.web.enabled': true,
  'tools.memory.enabled': true,
  'tools.sessions.enabled': true,
  'tools.skills.enabled': true,
  'tools.subagents.enabled': true,
  'tools.backgroundTasks.enabled': true,
  'tools.mentor.enabled': true,
  'tools.userInteraction.enabled': true,
  'tools.codeContext.enabled': true,
  'agent.completionVerification': true,
  'agent.backgroundCheckIn.enabled': true,
  'agent.backgroundCheckIn.intervalMs': 300_000,
  enable_agent_workflow: false,
  'agent.smartModel': undefined,
  'agent.smartReasoningEffort': undefined,
  'agent.balancedModel': undefined,
  'agent.balancedReasoningEffort': undefined,
  'agent.cheapModel': undefined,
  'agent.cheapReasoningEffort': undefined,
  'agent.choreModel': undefined,
  'agent.mentorPool': [],
  'verifier.model': '',
  'agent.favoriteModels': [],
  'agent.modelNicknames': {},
  'agent.useFlexServiceTier': false,
};
