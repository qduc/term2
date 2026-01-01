# Terminal Companion Mode

> Transform the app from an AI coding agent into a silent terminal companion that observes, learns, and assists when needed.

## Vision

Instead of the AI being the primary interface, the user's normal terminal remains primary. The AI watches silently in the background, building context from commands and outputs. When the user gets stuck or explicitly asks, the AI can assist or temporarily take control.

```
┌─────────────────────────────────────────────────────┐
│  Your Normal Terminal (zsh/bash)                    │
│  $ git status                                       │
│  $ npm test                                         │
│  ERROR: Module not found...                         │
│                                                     │
├─────────────────────────────────────────────────────┤
│  [AI Status Bar]  👁 Watching │ Ctrl+L: Ask AI      │
│  💡 Noticed test failure - type `??` for help       │
└─────────────────────────────────────────────────────┘
```

## Core Modes

Two modes with a clear mental model:

| Mode | Mindset | Trigger | Behavior |
|------|---------|---------|----------|
| **Watch** | "I got this, help if I ask" | Default | Silent observer, answers `??`, shows subtle hints on errors |
| **Auto** | "You handle it" | `!auto <task>` | AI takes full control, executes until done or Ctrl+C |

```
┌─────────────────────────────────────────────────────┐
│  Watch Mode (default)                               │
│                                                     │
│  $ npm test                                         │
│  $ git status                                       │
│  $ ?? why did this fail     ← AI responds inline    │
│                                                     │
│  User drives. AI assists on request.                │
├─────────────────────────────────────────────────────┤
│  !auto fix the failing tests                        │
├─────────────────────────────────────────────────────┤
│  Auto Mode                                          │
│                                                     │
│  [AI] Running npm test...                           │
│  [AI] Found issue in auth.test.ts                   │
│  [AI] Applying fix...                               │
│  [AI] Tests passing. Done.                          │
│                                                     │
│  AI drives. User watches. Ctrl+C to abort.          │
└─────────────────────────────────────────────────────┘
```

## Architecture

### Component Overview

```
┌───────────────────────────────────────────────────────────────┐
│                       Companion App                            │
├───────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌───────────────┐  ┌─────────────────┐      │
│  │ PTY Wrapper │→ │ Context Buffer │→ │ Event Detector │      │
│  └─────────────┘  └───────┬───────┘  └─────────────────┘      │
│         │                 │                    │               │
│         ▼                 ▼                    ▼               │
│  ┌─────────────┐  ┌───────────────┐   ┌─────────────────┐     │
│  │  User Shell │  │ Command Index │   │  Mode Manager   │     │
│  │  (zsh/bash) │  │ (last 10 cmds)│   │  (watch/auto)   │     │
│  └─────────────┘  └───────┬───────┘   └────────┬────────┘     │
│                           │                    │               │
│                           ▼                    ▼               │
│         ┌─────────────────────────────────────────────┐       │
│         │              Agent Core (existing)          │       │
│         │  ┌────────────────────────────────────────┐ │       │
│         │  │ Tools: terminal_history, shell, etc.   │ │       │
│         │  └────────────────────────────────────────┘ │       │
│         └─────────────────┬───────────────────────────┘       │
│                           │ on tool call                       │
│                           ▼                                    │
│         ┌─────────────────────────────────────────────┐       │
│         │  Summarizer (small LLM: Haiku/4o-mini)      │       │
│         │  - Fetches from Context Buffer              │       │
│         │  - Returns compressed output                │       │
│         └─────────────────────────────────────────────┘       │
├───────────────────────────────────────────────────────────────┤
│  [Status Bar UI]  Command Index always visible to AI          │
└───────────────────────────────────────────────────────────────┘
```

### New Components

| Component | Purpose |
|-----------|---------|
| `pty-wrapper.ts` | Spawn user's shell in PTY, intercept I/O |
| `context-buffer.ts` | Rolling window of commands + full outputs (raw storage) |
| `command-index.ts` | Lightweight index of last N commands (always in AI context) |
| `terminal-history.ts` | Tool for AI to query command outputs on-demand |
| `summarizer.ts` | Small LLM integration for output compression |
| `output-classifier.ts` | Detect output type (test/build/git) for smart prompts |
| `event-detector.ts` | Pattern matching for errors, loops, pauses |
| `mode-manager.ts` | Handle mode transitions and state |
| `status-bar.tsx` | Minimal UI overlay |
| `companion-app.tsx` | Main companion mode entry |

### Reused Components (from existing app)

- Agent configuration (`agent.ts`)
- Tool implementations (`tools/`)
- Provider registry (`providers/`)
- Settings service (`services/settings-service.ts`)
- Logging (`services/logging.ts`)
- Streaming infrastructure

## Directory Structure

```
source/
├── cli.tsx                    # Entry point - add --companion flag
├── modes/
│   ├── chat/                  # Current app (refactored)
│   │   ├── chat-app.tsx
│   │   └── ...
│   └── companion/             # New companion mode
│       ├── companion-app.tsx
│       ├── pty-wrapper.ts
│       ├── context-buffer.ts     # Raw storage ring buffer
│       ├── command-index.ts      # Lightweight index generator
│       ├── terminal-history.ts   # On-demand query tool
│       ├── summarizer.ts         # Small LLM summarization
│       ├── output-classifier.ts  # Detect output type
│       ├── event-detector.ts
│       ├── mode-manager.ts
│       └── components/
│           └── status-bar.tsx
├── agent.ts                   # Shared
├── tools/                     # Shared
├── providers/                 # Shared
└── services/                  # Shared
```

## Smart Triggers (Watch Mode)

In Watch mode, the AI detects patterns and shows subtle hints in the status bar:

| Pattern | Detection | Hint |
|---------|-----------|------|
| Error cascade | 3+ consecutive failed commands | 💡 "Stuck? `??` for help" |
| Retry loop | Same command repeated 2+ times | 💡 "Try `?? why isn't this working`" |
| Long pause | No input 30s+ after error | 💡 "Need help with that error?" |

User interactions:

| Input | Action |
|-------|--------|
| `??` | AI responds with context-aware help |
| `?? <question>` | AI answers specific question |
| `!auto <task>` | Switch to Auto mode |

## User Interactions

### Watch Mode: Asking for Help

```bash
$ npm test
# ... error output ...
$ ??
# AI responds with context-aware help inline

$ ?? why did this fail
# AI explains with full context of recent commands

$ ?? how do I revert the last commit
# AI answers, user stays in control
```

### Auto Mode: Delegating to AI

```bash
$ !auto fix the failing tests
# AI takes over:
#   [AI] Analyzing test output...
#   [AI] Found TypeError in auth.test.ts:42
#   [AI] Editing file...
#   [AI] Running npm test...        ← GREEN: auto-executed
#   [AI] All tests passing. Done.
# Returns to Watch mode

$ !auto set up a new React component called UserProfile
# AI creates files, updates imports, etc.
#   [AI] Creating src/components/UserProfile.tsx...
#   [AI] npm install classnames     ← YELLOW: asks approval
#   [Approve? y/n]
# Ctrl+C anytime to abort and return to Watch mode
```

### Auto Mode Safety (reuses existing command-safety)

Auto mode still validates commands through the safety classifier:

| Safety Level | Examples | Auto Mode Behavior |
|--------------|----------|-------------------|
| **GREEN** | `ls`, `grep`, `git status`, `cat` | Execute immediately |
| **YELLOW** | `npm install`, `node script.js`, unknown commands | Pause for approval |
| **RED** | `rm`, `sudo`, `curl`, `chmod` | Reject with explanation |

```
┌─────────────────────────────────────────────────────┐
│  Auto Mode                                          │
│                                                     │
│  [AI] Running git status...        ✓ GREEN: auto   │
│  [AI] Running npm test...          ✓ GREEN: auto   │
│  [AI] Running npm install lodash                   │
│       ⚠ YELLOW: Requires approval                  │
│       Install new package? [y/n]: █                │
│                                                     │
│  [AI] Attempting rm -rf node_modules               │
│       ✗ RED: Blocked (destructive command)         │
│       Skipping...                                  │
└─────────────────────────────────────────────────────┘
```

This ensures "you handle it" doesn't mean "do anything without limits".

## Implementation Phases

> **Constraint**: Each phase must have passing tests before proceeding to the next phase. Follow TDD—write tests first, then implement the minimum code to pass them. No phase is complete without test coverage proving it works.

### Phase 1: Foundation
- [ ] Refactor: move current UI code to `modes/chat/`
- [ ] Add `--companion` / `-c` CLI flag
- [ ] Basic PTY wrapper with passthrough (shell works normally)
- [ ] Verify existing shell functionality unaffected
- **Tests**: PTY spawns shell, I/O passthrough works, resize handling, CLI flag parsing

### Phase 2: Context Building
- [ ] Implement context buffer (rolling command history)
- [ ] Capture command + output pairs
- [ ] Build lightweight command index
- [ ] Implement `terminal_history` tool with summarization
- **Tests**: Buffer stores/evicts correctly, index generation, tool returns correct data, summarization triggers appropriately

### Phase 3: Watch Mode - Basic
- [ ] Implement `??` command detection
- [ ] Route to AI with command index + on-demand context
- [ ] Display AI response inline
- [ ] Return control to user shell
- **Tests**: `??` detected in input stream, context passed to AI, response displayed, shell regains control

### Phase 4: Watch Mode - Smart Hints
- [ ] Minimal status bar component
- [ ] Error pattern detection (cascades, retry loops)
- [ ] Show subtle hints in status bar
- [ ] Configurable triggers
- **Tests**: Error patterns detected correctly, hints appear/disappear, triggers fire at right thresholds

### Phase 5: Auto Mode
- [ ] Implement `!auto <task>` parsing
- [ ] AI command generation with full context
- [ ] Command injection into PTY
- [ ] Safety classification (GREEN/YELLOW/RED) integration
- [ ] Ctrl+C interrupt handling
- [ ] Graceful handoff back to Watch mode
- **Tests**: Task parsing, GREEN auto-executes, YELLOW prompts, RED blocks, Ctrl+C aborts cleanly, mode transitions

### Phase 6: Polish
- [ ] Settings integration (enable/disable hints)
- [ ] Customizable triggers
- [ ] History persistence across sessions
- [ ] Performance optimization
- **Tests**: Settings load/save, custom triggers work, history survives restart, no perf regressions

## Context Management Strategy

### Problem

If the AI consumes all terminal output directly, the context window fills up quickly. A single `npm install` or test run can produce thousands of lines.

### Solution: Lightweight Index + On-Demand Tool

Two-layer approach:

1. **Always in context**: Minimal command index (~10 commands)
2. **On-demand**: Tool to fetch full/summarized output

```
┌─────────────────────────────────────────────────────────────┐
│  ALWAYS IN CONTEXT (lightweight index)                      │
│                                                             │
│  Recent commands:                                           │
│  [0] npm test              ✗ exit:1    5s ago    (542 lines)│
│  [1] git diff              ✓ exit:0    30s ago   (23 lines) │
│  [2] npm install           ✓ exit:0    2m ago    (891 lines)│
│  [3] cd src/components     ✓ exit:0    3m ago    (0 lines)  │
│  ...                                                        │
│                                                             │
│  Use terminal_history tool to fetch command output details. │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  ON-DEMAND (via terminal_history tool)                      │
│                                                             │
│  terminal_history({ index: 0, detail: "errors_only" })      │
│  → Returns summarized/filtered output from small LLM        │
└─────────────────────────────────────────────────────────────┘
```

### Command Index Structure

```typescript
// Lightweight, always included in AI context
interface CommandIndex {
  index: number;
  command: string;        // The command that was run
  exitCode: number;       // 0 = success, non-zero = failure
  relativeTime: string;   // "5s ago", "2m ago"
  outputLines: number;    // Size hint for the AI
  hasErrors: boolean;     // Quick flag for error detection
}

// ~50-100 tokens for 10 commands - negligible context cost
```

### Terminal History Tool

```typescript
// tools/terminal-history.ts

interface TerminalHistoryParams {
  // What to fetch
  index?: number;           // Specific command by index
  lastN?: number;           // Last N commands (default: 3)
  search?: string;          // Search command/output text

  // How to return it
  detail: "summary" | "full" | "errors_only";
  maxLines?: number;        // Limit output size
}

// Example tool calls:

// "I see npm test failed, let me check what went wrong"
{ index: 0, detail: "errors_only" }

// "Let me review the recent git changes"
{ search: "git diff", detail: "full" }

// "Summarize what happened in the last few commands"
{ lastN: 3, detail: "summary" }
```

### Summarization Layer

Uses a small, fast LLM (Haiku/GPT-4o-mini) to compress output:

```
┌─────────────────────────────────────────────────────────────┐
│  Raw Buffer (memory)                                        │
│  - Ring buffer of last N commands + full output             │
│  - No token limits, just memory limits (~1MB)               │
└──────────────────────────┬──────────────────────────────────┘
                           │ tool call
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  Summarization Layer                                        │
│  - Small LLM: Haiku / GPT-4o-mini / local                   │
│  - Prompt varies by output type (test, build, git, etc.)    │
│  - Caches summaries to avoid re-processing                  │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  Main Agent                                                 │
│  - Receives clean, compressed context                       │
│  - Can request more detail if needed                        │
└─────────────────────────────────────────────────────────────┘
```

### Summarization Prompts by Output Type

```typescript
const SUMMARIZATION_PROMPTS = {
  test_results: `Summarize test results:
    - Total passed/failed/skipped
    - Names of failing tests
    - First error message for each failure
    - Key stack trace lines`,

  build_output: `Summarize build output:
    - Success or failure
    - Error messages with file:line references
    - Warning count`,

  errors_only: `Extract only errors and warnings:
    - Error messages with context
    - Abbreviated stack traces
    - Omit successful operations`,

  summary: `Summarize concisely:
    - Exit code and success/failure
    - Key results or errors
    - Actionable information
    Keep under 100 words.`
};
```

### Smart Filtering (No LLM Needed)

For simple cases, skip LLM summarization:

```typescript
function shouldSummarize(entry: CommandEntry): boolean {
  // Small output: return as-is
  if (entry.outputLines < 50) return false;

  // Known simple commands: return as-is
  if (/^(cd|pwd|echo|which)/.test(entry.command)) return false;

  // Everything else: summarize
  return true;
}
```

### Benefits

| Aspect | Before | After |
|--------|--------|-------|
| Context per command | ~500-2000 tokens | ~10 tokens (index) |
| 10 commands | 5000-20000 tokens | ~100 tokens |
| Detail when needed | ❌ truncated | ✅ full via tool |
| Error visibility | Buried in noise | Highlighted in index |
| Cost | High (main model) | Low (small LLM for summaries) |

### Component Updates

```
source/modes/companion/
├── context-buffer.ts      # Raw storage + index generation
├── terminal-history.ts    # Tool implementation
├── summarizer.ts          # Small LLM summarization
└── output-classifier.ts   # Detect output type (test/build/git)
```

## Technical Considerations

### PTY Wrapper

Using `node-pty` to spawn the user's shell:

```typescript
import * as pty from 'node-pty';

const shell = process.env.SHELL || '/bin/bash';
const ptyProcess = pty.spawn(shell, [], {
  name: 'xterm-256color',
  cols: process.stdout.columns,
  rows: process.stdout.rows,
  cwd: process.cwd(),
  env: process.env,
});
```

### Context Buffer Strategy

- Store last N commands with their outputs
- Truncate very long outputs (keep first/last N lines)
- Include timestamps for recency weighting
- Semantic chunking for better AI context

### Command Injection

When AI takes control, inject keystrokes:

```typescript
ptyProcess.write('npm test\r');
```

### Terminal Resize Handling

```typescript
process.stdout.on('resize', () => {
  ptyProcess.resize(process.stdout.columns, process.stdout.rows);
});
```

## Integration with Existing Codebase

This section details how companion mode integrates with the existing term2 architecture.

### CLI Entry Point Integration

**File**: `source/cli.tsx`

The CLI uses Meow for argument parsing. Add companion mode flag alongside existing flags:

```typescript
// source/cli.tsx - Modified flags
const cli = meow(helpText, {
  importMeta: import.meta,
  flags: {
    model: { type: 'string', shortFlag: 'm' },
    reasoning: { type: 'string', shortFlag: 'r' },
    companion: { type: 'boolean', shortFlag: 'c' },  // NEW
  },
});
```

**Initialization Flow**:

```
┌─────────────────────────────────────────────────────────────────┐
│                     CLI Entry (cli.tsx)                          │
├─────────────────────────────────────────────────────────────────┤
│  1. Parse flags (meow)                                           │
│  2. Create LoggingService                                        │
│  3. Create SettingsService (merges defaults → file → env → CLI)  │
│  4. Create HistoryService                                        │
│                                                                  │
│  if (flags.companion) {                                          │
│    5a. Create CompanionApp services:                             │
│        - PTYWrapper                                              │
│        - ContextBuffer                                           │
│        - ModeManager                                             │
│        - Summarizer (with small LLM client)                      │
│        - CompanionAgentClient (reuses OpenAIAgentClient)         │
│    6a. Render <CompanionApp /> via Ink                           │
│  } else {                                                        │
│    5b. Create OpenAIAgentClient                                  │
│    6b. Create ConversationService                                │
│    7b. Render <App /> via Ink (current behavior)                 │
│  }                                                               │
└─────────────────────────────────────────────────────────────────┘
```

**Implementation**:

```typescript
// cli.tsx - Conditional rendering
if (cli.flags.companion) {
  // Companion mode initialization
  const ptyWrapper = new PTYWrapper({ logger: loggingService });
  const contextBuffer = new ContextBuffer({
    maxSize: settingsService.get('companion.maxContextBufferSize'),
    maxCommands: settingsService.get('companion.maxCommandIndexSize'),
  });
  const modeManager = new ModeManager();
  const summarizer = new Summarizer({
    model: settingsService.get('companion.summarizerModel'),
    provider: settingsService.get('companion.summarizerProvider'),
    settings: settingsService,
    logger: loggingService,
  });

  render(
    <CompanionApp
      ptyWrapper={ptyWrapper}
      contextBuffer={contextBuffer}
      modeManager={modeManager}
      summarizer={summarizer}
      settingsService={settingsService}
      loggingService={loggingService}
    />
  );
} else {
  // Existing chat mode initialization (unchanged)
  const agentClient = new OpenAIAgentClient({...});
  const conversationService = new ConversationService({...});
  render(<App conversationService={conversationService} ... />);
}
```

### Agent Configuration Integration

**File**: `source/agent.ts`

Extend `getAgentDefinition()` to support companion mode with different tool sets and prompts.

```typescript
// source/agent.ts - Extended interface
export interface AgentDefinitionOptions {
  deps: { settings: SettingsService; logger: LoggingService };
  model?: string;
  mode?: 'chat' | 'companion-watch' | 'companion-auto';
  commandIndex?: CommandIndexEntry[];  // Injected for companion mode
}

export const getAgentDefinition = (options: AgentDefinitionOptions): AgentDefinition => {
  const { deps, model, mode = 'chat', commandIndex } = options;

  // Tool selection based on mode
  const tools = getToolsForMode(mode, deps);

  // Prompt selection with command index injection
  const instructions = buildInstructions(model, mode, commandIndex);

  return { name: 'term2', instructions, tools, model };
};

function getToolsForMode(mode: string, deps): ToolDefinition[] {
  switch (mode) {
    case 'companion-watch':
      // Read-only tools only
      return [
        terminalHistoryToolDefinition,  // NEW - query command history
        readFileToolDefinition,
        findFilesToolDefinition,
        grepToolDefinition,
      ];

    case 'companion-auto':
      // Full tool set (same as chat mode)
      return [
        terminalHistoryToolDefinition,  // NEW
        createShellToolDefinition(deps),
        createApplyPatchToolDefinition(deps),
        createSearchReplaceToolDefinition(deps),
        readFileToolDefinition,
        findFilesToolDefinition,
        grepToolDefinition,
      ];

    default: // 'chat'
      // Current behavior (unchanged)
      return [...existingTools];
  }
}
```

**Prompt Injection**:

```typescript
// source/agent.ts - Companion mode system prompt
function buildInstructions(model: string, mode: string, commandIndex?: CommandIndexEntry[]): string {
  const basePrompt = getPromptForModel(model);

  if (mode.startsWith('companion-') && commandIndex) {
    const indexSection = formatCommandIndex(commandIndex);
    return `${basePrompt}

## Terminal Context

You are observing the user's terminal session. Here are the recent commands:

${indexSection}

Use the terminal_history tool to fetch detailed output when needed.
${mode === 'companion-watch'
  ? 'You are in Watch mode - provide helpful suggestions but do not execute commands.'
  : 'You are in Auto mode - you may execute commands to complete the requested task.'}
`;
  }

  return basePrompt;
}

function formatCommandIndex(entries: CommandIndexEntry[]): string {
  return entries.map((e, i) =>
    `[${i}] ${e.command.padEnd(25)} ${e.exitCode === 0 ? '✓' : '✗'} exit:${e.exitCode}  ${e.relativeTime}  (${e.outputLines} lines)`
  ).join('\n');
}
```

### Tool System Integration

**File**: `source/modes/companion/terminal-history.ts`

Implement `terminal_history` following the existing `ToolDefinition` interface from `source/tools/types.ts`:

```typescript
// source/modes/companion/terminal-history.ts
import { z } from 'zod';
import type { ToolDefinition, CommandMessage } from '../../tools/types.js';
import type { ContextBuffer } from './context-buffer.js';
import type { Summarizer } from './summarizer.js';

const TerminalHistoryParamsSchema = z.object({
  index: z.number().int().min(0).optional()
    .describe('Specific command by index (0 = most recent)'),
  lastN: z.number().int().min(1).max(10).optional()
    .describe('Fetch last N commands (default: 3)'),
  search: z.string().optional()
    .describe('Search pattern for command or output text'),
  detail: z.enum(['summary', 'full', 'errors_only'])
    .describe('Level of detail to return'),
  maxLines: z.number().int().min(1).optional()
    .describe('Maximum output lines to return'),
});

type TerminalHistoryParams = z.infer<typeof TerminalHistoryParamsSchema>;

export function createTerminalHistoryToolDefinition(deps: {
  contextBuffer: ContextBuffer;
  summarizer: Summarizer;
}): ToolDefinition<TerminalHistoryParams> {
  const { contextBuffer, summarizer } = deps;

  return {
    name: 'terminal_history',
    description: `Query the terminal command history. Use this to get details about recent commands and their outputs.

Available in the command index (always visible):
- Command text
- Exit code (0 = success)
- Relative time
- Output line count

Use this tool to fetch:
- Full command output
- Summarized output (for long outputs)
- Errors only (filtered view)`,

    parameters: TerminalHistoryParamsSchema,

    // Read-only tool - never needs approval
    needsApproval: () => false,

    execute: async (params: TerminalHistoryParams) => {
      const { index, lastN = 3, search, detail, maxLines } = params;

      // Fetch entries from buffer
      let entries = index !== undefined
        ? [contextBuffer.getEntry(index)]
        : search
          ? contextBuffer.search(search, lastN)
          : contextBuffer.getLastN(lastN);

      entries = entries.filter(Boolean);

      if (entries.length === 0) {
        return { success: false, error: 'No matching commands found' };
      }

      // Process based on detail level
      const results = await Promise.all(entries.map(async (entry) => {
        let output: string;

        if (detail === 'full') {
          output = entry.output;
          if (maxLines && output.split('\n').length > maxLines) {
            const lines = output.split('\n');
            output = [...lines.slice(0, maxLines), `... (${lines.length - maxLines} more lines)`].join('\n');
          }
        } else if (shouldSummarize(entry)) {
          output = await summarizer.summarize(entry, detail);
        } else {
          output = entry.output;
        }

        return {
          command: entry.command,
          exitCode: entry.exitCode,
          timestamp: entry.timestamp,
          output,
        };
      }));

      return { success: true, results };
    },

    formatCommandMessage: (item, index, toolCallArgumentsById): CommandMessage[] => {
      const args = toolCallArgumentsById.get(item.callId) as TerminalHistoryParams;
      return [{
        type: 'info',
        title: `terminal_history(${args.detail})`,
        content: item.output ? JSON.stringify(item.output, null, 2) : 'No results',
      }];
    },
  };
}

function shouldSummarize(entry: CommandEntry): boolean {
  if (entry.outputLines < 50) return false;
  if (/^(cd|pwd|echo|which|true|false)/.test(entry.command)) return false;
  return true;
}
```

**Tool Registration** in agent.ts:

```typescript
// In getToolsForMode(), import and use:
import { createTerminalHistoryToolDefinition } from './modes/companion/terminal-history.js';

// Pass contextBuffer and summarizer via deps
const terminalHistoryTool = createTerminalHistoryToolDefinition({
  contextBuffer: deps.contextBuffer,
  summarizer: deps.summarizer,
});
```

### Settings Schema Extension

**File**: `source/services/settings-service.ts`

Add companion-specific settings to the Zod schema:

```typescript
// source/services/settings-service.ts - Schema additions

const CompanionSettingsSchema = z.object({
  // Feature toggles
  enabled: z.boolean().default(false)
    .describe('Enable companion mode features'),
  showHints: z.boolean().default(true)
    .describe('Show smart hints in status bar'),

  // Smart trigger thresholds
  errorCascadeThreshold: z.number().int().min(1).default(3)
    .describe('Consecutive failures before showing hint'),
  retryLoopThreshold: z.number().int().min(1).default(2)
    .describe('Repeated commands before showing hint'),
  pauseHintDelayMs: z.number().int().min(0).default(30000)
    .describe('Milliseconds of inactivity after error before hint'),

  // Context management
  maxContextBufferSize: z.number().int().min(1024).default(1048576)
    .describe('Maximum buffer size in bytes (default: 1MB)'),
  maxCommandIndexSize: z.number().int().min(1).max(50).default(10)
    .describe('Number of commands in lightweight index'),

  // Summarizer configuration
  summarizerModel: z.string().default('gpt-4o-mini')
    .describe('Model for output summarization'),
  summarizerProvider: z.string().default('openai')
    .describe('Provider for summarizer model'),
  summarizerMaxTokens: z.number().int().min(100).default(500)
    .describe('Max tokens for summarization response'),

  // Auto mode settings
  autoModeTimeout: z.number().int().min(0).default(300000)
    .describe('Auto mode timeout in ms (default: 5 minutes)'),
}).default({});

// Add to main settings schema
const SettingsSchema = z.object({
  agent: AgentSettingsSchema,
  shell: ShellSettingsSchema,
  ui: UISettingsSchema,
  logging: LoggingSettingsSchema,
  environment: EnvironmentSettingsSchema,
  app: AppSettingsSchema,
  tools: ToolsSettingsSchema,
  debug: DebugSettingsSchema,
  providers: ProvidersSchema,
  companion: CompanionSettingsSchema,  // NEW
});

// Runtime modifiable companion settings
const RUNTIME_MODIFIABLE_KEYS = new Set([
  // ... existing keys ...
  'companion.showHints',
  'companion.errorCascadeThreshold',
  'companion.retryLoopThreshold',
  'companion.pauseHintDelayMs',
  'companion.summarizerModel',
  'companion.summarizerProvider',
]);

// Sensitive keys (env-only, never persisted)
const SENSITIVE_KEYS = new Set([
  // ... existing keys ...
  // Note: summarizerProvider uses main provider's API key
]);
```

**Default Settings**:

```typescript
const DEFAULT_SETTINGS: Settings = {
  // ... existing defaults ...
  companion: {
    enabled: false,
    showHints: true,
    errorCascadeThreshold: 3,
    retryLoopThreshold: 2,
    pauseHintDelayMs: 30000,
    maxContextBufferSize: 1048576,
    maxCommandIndexSize: 10,
    summarizerModel: 'gpt-4o-mini',
    summarizerProvider: 'openai',
    summarizerMaxTokens: 500,
    autoModeTimeout: 300000,
  },
};
```

### Provider Integration for Summarizer

The summarizer uses a lightweight approach - direct API calls rather than full agent infrastructure.

**File**: `source/modes/companion/summarizer.ts`

```typescript
// source/modes/companion/summarizer.ts
import OpenAI from 'openai';
import { getProvider } from '../../providers/registry.js';
import type { SettingsService } from '../../services/settings-service.js';
import type { LoggingService } from '../../services/logging-service.js';
import type { CommandEntry } from './context-buffer.js';

interface SummarizerDeps {
  settings: SettingsService;
  logger: LoggingService;
}

export class Summarizer {
  #client: OpenAI | null = null;
  #settings: SettingsService;
  #logger: LoggingService;
  #cache: Map<string, { summary: string; timestamp: number }> = new Map();
  #cacheTTL = 5 * 60 * 1000; // 5 minutes

  constructor(deps: SummarizerDeps) {
    this.#settings = deps.settings;
    this.#logger = deps.logger;
  }

  async #getClient(): Promise<OpenAI> {
    if (this.#client) return this.#client;

    const provider = this.#settings.get('companion.summarizerProvider');
    const providerDef = getProvider(provider);

    // Use provider's base URL and API key configuration
    const baseURL = provider === 'openai'
      ? undefined
      : this.#settings.get(`agent.${provider}.baseUrl`);
    const apiKey = provider === 'openai'
      ? process.env.OPENAI_API_KEY
      : this.#settings.get(`agent.${provider}.apiKey`) || process.env.OPENAI_API_KEY;

    this.#client = new OpenAI({ apiKey, baseURL });
    return this.#client;
  }

  async summarize(
    entry: CommandEntry,
    detail: 'summary' | 'errors_only'
  ): Promise<string> {
    // Check cache
    const cacheKey = `${entry.command}:${entry.timestamp}:${detail}`;
    const cached = this.#cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.#cacheTTL) {
      return cached.summary;
    }

    const client = await this.#getClient();
    const model = this.#settings.get('companion.summarizerModel');
    const maxTokens = this.#settings.get('companion.summarizerMaxTokens');

    const prompt = this.#buildPrompt(entry, detail);

    try {
      const response = await client.chat.completions.create({
        model,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: 'You are a concise technical summarizer. Extract key information only.' },
          { role: 'user', content: prompt },
        ],
      });

      const summary = response.choices[0]?.message?.content || entry.output;

      // Cache result
      this.#cache.set(cacheKey, { summary, timestamp: Date.now() });

      return summary;
    } catch (error) {
      this.#logger.error('Summarization failed', { error, command: entry.command });
      // Fallback: return truncated raw output
      return this.#truncateOutput(entry.output, 50);
    }
  }

  #buildPrompt(entry: CommandEntry, detail: 'summary' | 'errors_only'): string {
    const outputType = classifyOutputType(entry);
    const basePrompt = SUMMARIZATION_PROMPTS[outputType] || SUMMARIZATION_PROMPTS.summary;

    return `Command: ${entry.command}
Exit code: ${entry.exitCode}

Output:
\`\`\`
${entry.output}
\`\`\`

${detail === 'errors_only' ? SUMMARIZATION_PROMPTS.errors_only : basePrompt}`;
  }

  #truncateOutput(output: string, maxLines: number): string {
    const lines = output.split('\n');
    if (lines.length <= maxLines) return output;
    return [...lines.slice(0, maxLines), `... (${lines.length - maxLines} more lines)`].join('\n');
  }

  clearCache(): void {
    this.#cache.clear();
  }
}

const SUMMARIZATION_PROMPTS = {
  test_results: `Summarize test results:
- Total passed/failed/skipped
- Names of failing tests
- First error message for each failure
- Key stack trace lines (file:line only)`,

  build_output: `Summarize build output:
- Success or failure
- Error messages with file:line references
- Warning count (if any)`,

  git_output: `Summarize git output:
- Operation performed
- Files affected (count or list if few)
- Any conflicts or errors`,

  errors_only: `Extract only errors and warnings:
- Error messages with context
- File:line references
- Omit successful operations`,

  summary: `Summarize concisely in under 100 words:
- Success or failure
- Key results or errors
- Actionable next steps (if any)`,
};

function classifyOutputType(entry: CommandEntry): keyof typeof SUMMARIZATION_PROMPTS {
  const cmd = entry.command.toLowerCase();
  if (/^(npm test|yarn test|jest|vitest|ava|mocha)/.test(cmd)) return 'test_results';
  if (/^(npm run build|yarn build|tsc|webpack|vite build)/.test(cmd)) return 'build_output';
  if (/^git\s/.test(cmd)) return 'git_output';
  return 'summary';
}
```

### Conversation Session Management

**File**: `source/modes/companion/companion-session.ts`

Companion mode uses lightweight sessions that don't persist conversation history.

```typescript
// source/modes/companion/companion-session.ts
import { OpenAIAgentClient } from '../../lib/openai-agent-client.js';
import { getAgentDefinition } from '../../agent.js';
import type { ContextBuffer } from './context-buffer.js';
import type { Summarizer } from './summarizer.js';
import type { SettingsService } from '../../services/settings-service.js';
import type { LoggingService } from '../../services/logging-service.js';

interface CompanionSessionDeps {
  contextBuffer: ContextBuffer;
  summarizer: Summarizer;
  settings: SettingsService;
  logger: LoggingService;
}

type CompanionMode = 'watch' | 'auto';

/**
 * Lightweight session for companion mode queries.
 *
 * Unlike chat mode's ConversationSession:
 * - No persistent conversation history (each query is standalone)
 * - No previousResponseId chaining
 * - Simpler approval flow (Auto mode only)
 */
export class CompanionSession {
  #agentClient: OpenAIAgentClient;
  #contextBuffer: ContextBuffer;
  #summarizer: Summarizer;
  #settings: SettingsService;
  #logger: LoggingService;
  #currentMode: CompanionMode = 'watch';

  constructor(deps: CompanionSessionDeps) {
    this.#contextBuffer = deps.contextBuffer;
    this.#summarizer = deps.summarizer;
    this.#settings = deps.settings;
    this.#logger = deps.logger;

    // Create agent client with companion-specific configuration
    this.#agentClient = new OpenAIAgentClient({
      model: this.#settings.get('agent.model'),
      reasoningEffort: this.#settings.get('agent.reasoningEffort'),
      maxTurns: 10, // Lower than chat mode - companion queries should be quick
      deps: { settings: this.#settings, logger: this.#logger },
    });
  }

  get mode(): CompanionMode {
    return this.#currentMode;
  }

  setMode(mode: CompanionMode): void {
    this.#currentMode = mode;
    this.#logger.info(`Companion mode changed to: ${mode}`);
  }

  /**
   * Handle a ?? query in Watch mode.
   * Creates ephemeral session, streams response, then disposes.
   */
  async *handleWatchQuery(query: string): AsyncGenerator<CompanionEvent> {
    const commandIndex = this.#contextBuffer.getIndex();

    const agentDef = getAgentDefinition({
      deps: {
        settings: this.#settings,
        logger: this.#logger,
        contextBuffer: this.#contextBuffer,
        summarizer: this.#summarizer,
      },
      model: this.#settings.get('agent.model'),
      mode: 'companion-watch',
      commandIndex,
    });

    // Stream response
    for await (const event of this.#agentClient.startStream(query, agentDef)) {
      if (event.type === 'text_delta') {
        yield { type: 'text', content: event.content };
      } else if (event.type === 'tool_call') {
        yield { type: 'tool_call', tool: event.tool, args: event.args };
      } else if (event.type === 'final') {
        yield { type: 'complete', content: event.finalText };
      }
    }
  }

  /**
   * Handle !auto task in Auto mode.
   * Full agent loop with tool execution and approval flow.
   */
  async *handleAutoTask(task: string): AsyncGenerator<CompanionEvent> {
    this.setMode('auto');

    try {
      const commandIndex = this.#contextBuffer.getIndex();

      const agentDef = getAgentDefinition({
        deps: {
          settings: this.#settings,
          logger: this.#logger,
          contextBuffer: this.#contextBuffer,
          summarizer: this.#summarizer,
        },
        model: this.#settings.get('agent.model'),
        mode: 'companion-auto',
        commandIndex,
      });

      for await (const event of this.#agentClient.startStream(task, agentDef)) {
        if (event.type === 'text_delta') {
          yield { type: 'text', content: event.content };
        } else if (event.type === 'tool_call') {
          // Classify command safety for approval
          const safety = classifyCommandSafety(event.tool, event.args);
          yield {
            type: 'tool_call',
            tool: event.tool,
            args: event.args,
            safety, // GREEN/YELLOW/RED
          };

          if (safety === 'yellow') {
            yield { type: 'approval_required', tool: event.tool, args: event.args };
          } else if (safety === 'red') {
            yield { type: 'blocked', tool: event.tool, reason: 'Destructive command blocked' };
          }
        } else if (event.type === 'final') {
          yield { type: 'complete', content: event.finalText };
        }
      }
    } finally {
      this.setMode('watch');
    }
  }

  abort(): void {
    this.#agentClient.abort();
    this.setMode('watch');
  }
}

type CompanionEvent =
  | { type: 'text'; content: string }
  | { type: 'tool_call'; tool: string; args: unknown; safety?: 'green' | 'yellow' | 'red' }
  | { type: 'approval_required'; tool: string; args: unknown }
  | { type: 'blocked'; tool: string; reason: string }
  | { type: 'complete'; content: string };
```

### Mode Hierarchy & Relationships

Companion mode is a separate app mode, not a modifier to chat mode.

```
┌─────────────────────────────────────────────────────────────────┐
│                        App Modes                                 │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  Chat Mode (default, no --companion flag)               │    │
│  │  ┌─────────────────────────────────────────────────┐    │    │
│  │  │  Modifiers (toggles within chat mode):          │    │    │
│  │  │  • Edit Mode (Shift+Tab / /setting)             │    │    │
│  │  │    - Auto-approves apply_patch operations       │    │    │
│  │  │  • Mentor Mode (/mentor / /setting)             │    │    │
│  │  │    - Uses mentor model for guidance             │    │    │
│  │  └─────────────────────────────────────────────────┘    │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  Companion Mode (--companion / -c flag)                 │    │
│  │  ┌─────────────────────────────────────────────────┐    │    │
│  │  │  Sub-modes (within companion):                  │    │    │
│  │  │  • Watch Mode (default)                         │    │    │
│  │  │    - Passive observation                        │    │    │
│  │  │    - Responds to ?? queries                     │    │    │
│  │  │    - Shows hints on errors                      │    │    │
│  │  │  • Auto Mode (!auto <task>)                     │    │    │
│  │  │    - AI takes control                           │    │    │
│  │  │    - Executes commands with safety checks       │    │    │
│  │  │    - Returns to Watch on completion/abort       │    │    │
│  │  └─────────────────────────────────────────────────┘    │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
│  Note: Chat Mode and Companion Mode are mutually exclusive.      │
│  The --companion flag determines which mode to enter at launch.  │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

**State Persistence**:

| Setting | Persisted | Source |
|---------|-----------|--------|
| `app.editMode` | Yes | Config file |
| `app.mentorMode` | Yes | Config file |
| Companion Watch/Auto | No | Runtime only (always starts in Watch) |

### PTY + Ink UI Integration

The challenge: PTY needs direct terminal access, but Ink wants to control rendering.

**Recommended Approach: PTY Direct + Cursor-Positioned Status Bar**

```
┌─────────────────────────────────────────────────────────────────┐
│  Terminal (full height - status bar height)                      │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                                                             ││
│  │  PTY Output (node-pty writes directly to stdout)            ││
│  │  $ npm test                                                 ││
│  │  FAIL src/utils.test.ts                                     ││
│  │  ● should validate input                                    ││
│  │                                                             ││
│  └─────────────────────────────────────────────────────────────┘│
│  ┌─────────────────────────────────────────────────────────────┐│
│  │  Status Bar (Ink controls via ANSI cursor positioning)      ││
│  │  [Watch] 👁 │ ?? for help │ 💡 Test failed - need help?     ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

**Implementation Strategy**:

```typescript
// source/modes/companion/companion-app.tsx
import React, { useEffect, useState } from 'react';
import { render, Box, Text, useStdout } from 'ink';
import type { PTYWrapper } from './pty-wrapper.js';

interface CompanionAppProps {
  ptyWrapper: PTYWrapper;
  // ... other deps
}

export const CompanionApp: React.FC<CompanionAppProps> = ({ ptyWrapper, ...deps }) => {
  const { stdout } = useStdout();
  const [statusBarHeight] = useState(2); // Fixed height for status bar

  useEffect(() => {
    // Reserve bottom rows for status bar
    const setupTerminal = () => {
      const rows = process.stdout.rows;
      const ptyRows = rows - statusBarHeight;

      // Set PTY to use upper portion
      ptyWrapper.resize(process.stdout.columns, ptyRows);

      // Set scroll region to exclude status bar
      process.stdout.write(`\x1b[1;${ptyRows}r`); // Set scroll region
    };

    setupTerminal();
    process.stdout.on('resize', setupTerminal);

    // Start PTY
    ptyWrapper.start();

    return () => {
      process.stdout.off('resize', setupTerminal);
      process.stdout.write('\x1b[r'); // Reset scroll region
      ptyWrapper.stop();
    };
  }, [ptyWrapper, statusBarHeight]);

  // PTY handles its own output directly to stdout
  // Ink only renders the status bar at fixed bottom position

  return (
    <StatusBar
      position="bottom"
      height={statusBarHeight}
      {...deps}
    />
  );
};

// Status bar renders at fixed position using ANSI escape codes
const StatusBar: React.FC<{ position: 'bottom'; height: number }> = ({
  position,
  height,
  mode,
  hint,
}) => {
  const { stdout } = useStdout();

  useEffect(() => {
    // Move cursor to bottom and render
    const render = () => {
      const row = process.stdout.rows - height + 1;
      process.stdout.write(`\x1b[${row};1H`); // Move to row
      process.stdout.write(`\x1b[K`); // Clear line
      // Ink renders here
    };

    render();
  });

  return (
    <Box flexDirection="row" justifyContent="space-between">
      <Text>[{mode}] 👁</Text>
      <Text>?? for help</Text>
      {hint && <Text color="yellow">💡 {hint}</Text>}
    </Box>
  );
};
```

**Alternative Approaches** (documented for future consideration):

| Approach | Pros | Cons |
|----------|------|------|
| PTY Direct + Cursor Status | Native feel, low latency | Complex cursor management |
| Ink Captures PTY | Full React control | Added latency, buffering issues |
| tmux-style Split | Clean separation | Requires tmux or similar |
| Blessed/Terminal-kit | Better low-level control | Different from existing Ink stack |

## Testing Strategy

### Overview

Follow TDD approach: write tests first, implement minimum code to pass.

### Test Utilities Needed

```typescript
// test/companion/test-utils.ts

/**
 * Mock PTY for unit tests - avoids spawning real shells
 */
export function createMockPty(): MockPty {
  return {
    onData: jest.fn(),
    write: jest.fn(),
    resize: jest.fn(),
    kill: jest.fn(),
    // Simulate output
    simulateOutput: (data: string) => { /* trigger onData */ },
    simulateExit: (code: number) => { /* trigger exit */ },
  };
}

/**
 * Mock summarizer that returns canned responses
 */
export function createMockSummarizer(): MockSummarizer {
  const responses = new Map<string, string>();
  return {
    setResponse: (command: string, summary: string) => responses.set(command, summary),
    summarize: async (entry) => responses.get(entry.command) || 'Mock summary',
  };
}

/**
 * Context buffer test helper
 */
export function createTestContextBuffer(entries: CommandEntry[]): ContextBuffer {
  const buffer = new ContextBuffer({ maxSize: 1024 * 1024, maxCommands: 10 });
  entries.forEach(e => buffer.addEntry(e));
  return buffer;
}

/**
 * Assert command index contains expected entries
 */
export function assertCommandIndexContains(
  buffer: ContextBuffer,
  expected: Partial<CommandIndexEntry>[]
): void {
  const index = buffer.getIndex();
  expected.forEach((exp, i) => {
    expect(index[i]).toMatchObject(exp);
  });
}

/**
 * Simulate terminal input sequence
 */
export async function simulateTerminalInput(
  pty: MockPty,
  input: string,
  options?: { delay?: number }
): Promise<void> {
  for (const char of input) {
    pty.write(char);
    if (options?.delay) await sleep(options.delay);
  }
  pty.write('\r'); // Enter
}
```

### Test Categories by Phase

**Phase 1: Foundation Tests**

```typescript
// test/companion/pty-wrapper.test.ts
describe('PTYWrapper', () => {
  test('spawns user shell from SHELL env var', async () => {
    const mockPty = createMockPty();
    const wrapper = new PTYWrapper({ ptyFactory: () => mockPty });

    await wrapper.start();

    expect(mockPty.spawn).toHaveBeenCalledWith(
      process.env.SHELL,
      expect.any(Array),
      expect.objectContaining({ name: 'xterm-256color' })
    );
  });

  test('passes through I/O without modification', async () => {
    const mockPty = createMockPty();
    const wrapper = new PTYWrapper({ ptyFactory: () => mockPty });
    const received: string[] = [];

    wrapper.onOutput((data) => received.push(data));
    await wrapper.start();

    mockPty.simulateOutput('$ ls\nfile1.txt\nfile2.txt\n');

    expect(received.join('')).toBe('$ ls\nfile1.txt\nfile2.txt\n');
  });

  test('handles terminal resize', async () => {
    const mockPty = createMockPty();
    const wrapper = new PTYWrapper({ ptyFactory: () => mockPty });

    await wrapper.start();
    wrapper.resize(120, 40);

    expect(mockPty.resize).toHaveBeenCalledWith(120, 40);
  });
});

// test/companion/cli-flags.test.ts
describe('CLI companion flag', () => {
  test('--companion flag is parsed correctly', () => {
    const result = parseFlags(['--companion']);
    expect(result.companion).toBe(true);
  });

  test('-c shorthand works', () => {
    const result = parseFlags(['-c']);
    expect(result.companion).toBe(true);
  });

  test('companion flag coexists with other flags', () => {
    const result = parseFlags(['-c', '-m', 'gpt-4o', '-r', 'high']);
    expect(result.companion).toBe(true);
    expect(result.model).toBe('gpt-4o');
    expect(result.reasoning).toBe('high');
  });
});
```

**Phase 2: Context Building Tests**

```typescript
// test/companion/context-buffer.test.ts
describe('ContextBuffer', () => {
  test('stores commands with output', () => {
    const buffer = new ContextBuffer({ maxSize: 1024, maxCommands: 5 });

    buffer.addEntry({
      command: 'ls -la',
      output: 'file1.txt\nfile2.txt',
      exitCode: 0,
      timestamp: Date.now(),
    });

    expect(buffer.getLastN(1)[0].command).toBe('ls -la');
  });

  test('evicts oldest entries when buffer full', () => {
    const buffer = new ContextBuffer({ maxSize: 100, maxCommands: 2 });

    buffer.addEntry({ command: 'cmd1', output: 'out1', exitCode: 0, timestamp: 1 });
    buffer.addEntry({ command: 'cmd2', output: 'out2', exitCode: 0, timestamp: 2 });
    buffer.addEntry({ command: 'cmd3', output: 'out3', exitCode: 0, timestamp: 3 });

    const entries = buffer.getLastN(10);
    expect(entries.length).toBe(2);
    expect(entries[0].command).toBe('cmd3');
    expect(entries[1].command).toBe('cmd2');
  });

  test('generates lightweight index', () => {
    const buffer = new ContextBuffer({ maxSize: 1024, maxCommands: 10 });

    buffer.addEntry({
      command: 'npm test',
      output: 'FAIL: 2 tests failed\n'.repeat(100),
      exitCode: 1,
      timestamp: Date.now() - 5000,
    });

    const index = buffer.getIndex();

    expect(index[0]).toMatchObject({
      command: 'npm test',
      exitCode: 1,
      hasErrors: true,
      outputLines: 100,
    });
    expect(index[0].relativeTime).toMatch(/\d+s ago/);
  });
});

// test/companion/terminal-history-tool.test.ts
describe('terminal_history tool', () => {
  test('returns command output by index', async () => {
    const buffer = createTestContextBuffer([
      { command: 'npm test', output: 'All tests passed', exitCode: 0, timestamp: Date.now() },
    ]);
    const summarizer = createMockSummarizer();
    const tool = createTerminalHistoryToolDefinition({ contextBuffer: buffer, summarizer });

    const result = await tool.execute({ index: 0, detail: 'full' });

    expect(result.success).toBe(true);
    expect(result.results[0].output).toBe('All tests passed');
  });

  test('summarizes large output', async () => {
    const buffer = createTestContextBuffer([
      { command: 'npm test', output: 'line\n'.repeat(100), exitCode: 1, timestamp: Date.now() },
    ]);
    const summarizer = createMockSummarizer();
    summarizer.setResponse('npm test', '100 tests, 5 failed');

    const tool = createTerminalHistoryToolDefinition({ contextBuffer: buffer, summarizer });
    const result = await tool.execute({ index: 0, detail: 'summary' });

    expect(result.results[0].output).toBe('100 tests, 5 failed');
  });

  test('needsApproval returns false (read-only)', () => {
    const tool = createTerminalHistoryToolDefinition({
      contextBuffer: createTestContextBuffer([]),
      summarizer: createMockSummarizer(),
    });

    expect(tool.needsApproval({})).toBe(false);
  });
});
```

**Phase 3: Watch Mode Tests**

```typescript
// test/companion/watch-mode.test.ts
describe('Watch Mode', () => {
  test('detects ?? command in input stream', async () => {
    const detector = new InputDetector();
    const events: string[] = [];

    detector.onQuery((query) => events.push(query));

    detector.processInput('?? why did this fail');

    expect(events).toEqual(['why did this fail']);
  });

  test('routes ?? to AI with command index', async () => {
    const session = createTestCompanionSession();
    const responses: string[] = [];

    for await (const event of session.handleWatchQuery('why did this fail')) {
      if (event.type === 'text') responses.push(event.content);
    }

    expect(responses.length).toBeGreaterThan(0);
  });

  test('shell regains control after AI response', async () => {
    const pty = createMockPty();
    const app = createTestCompanionApp({ pty });

    // Simulate ?? query
    await simulateTerminalInput(pty, '?? help');
    await app.waitForAIResponse();

    // Verify shell is responsive
    await simulateTerminalInput(pty, 'echo test');
    expect(pty.lastOutput).toContain('test');
  });
});
```

**Phase 4-6: Additional test files for hints, auto mode, and settings...**

### Integration Tests

```typescript
// test/companion/integration.test.ts
describe('Companion Mode Integration', () => {
  test('full flow: command → error → ?? → AI response', async () => {
    const app = await launchCompanionMode();

    // Run failing command
    await app.runCommand('npm test');
    expect(app.contextBuffer.getIndex()[0].exitCode).toBe(1);

    // Ask for help
    const response = await app.askAI('??');
    expect(response).toContain('test'); // AI mentions the test

    // Verify still in watch mode
    expect(app.mode).toBe('watch');

    await app.cleanup();
  });

  test('auto mode executes commands with safety checks', async () => {
    const app = await launchCompanionMode();

    await app.runCommand('!auto create a test file');

    // Should see AI actions
    expect(app.events).toContainEqual(
      expect.objectContaining({ type: 'tool_call', tool: 'shell' })
    );

    // Should return to watch mode
    expect(app.mode).toBe('watch');
  });
});
```

## Error Handling & Edge Cases

### PTY Failures

```typescript
// source/modes/companion/pty-wrapper.ts
class PTYWrapper {
  async start(): Promise<void> {
    try {
      this.#pty = pty.spawn(shell, args, options);
    } catch (error) {
      this.#logger.error('Failed to spawn PTY', { error, shell });
      throw new CompanionError(
        'SHELL_SPAWN_FAILED',
        `Could not start shell: ${shell}. Check SHELL environment variable.`
      );
    }

    this.#pty.onExit(({ exitCode, signal }) => {
      this.#logger.warn('PTY exited unexpectedly', { exitCode, signal });
      this.emit('shell-exit', { exitCode, signal });
      // Attempt restart or notify user
      this.#handleUnexpectedExit(exitCode, signal);
    });
  }

  #handleUnexpectedExit(exitCode: number, signal?: number): void {
    if (this.#restartAttempts < MAX_RESTART_ATTEMPTS) {
      this.#restartAttempts++;
      this.#logger.info('Attempting to restart shell', { attempt: this.#restartAttempts });
      this.start().catch(() => this.emit('fatal-error', 'Shell restart failed'));
    } else {
      this.emit('fatal-error', 'Shell crashed repeatedly');
    }
  }
}
```

### AI Query Failures

```typescript
// source/modes/companion/companion-session.ts
async *handleWatchQuery(query: string): AsyncGenerator<CompanionEvent> {
  try {
    for await (const event of this.#agentClient.startStream(query, agentDef)) {
      yield this.#mapEvent(event);
    }
  } catch (error) {
    this.#logger.error('AI query failed', { error, query });

    if (isNetworkError(error)) {
      yield {
        type: 'error',
        message: 'Network error - check your connection and API key',
        recoverable: true,
      };
    } else if (isRateLimitError(error)) {
      yield {
        type: 'error',
        message: 'Rate limited - try again in a moment',
        recoverable: true,
      };
    } else {
      yield {
        type: 'error',
        message: 'AI query failed - see logs for details',
        recoverable: false,
      };
    }
  }
}
```

### Summarizer Failures

```typescript
// source/modes/companion/summarizer.ts
async summarize(entry: CommandEntry, detail: string): Promise<string> {
  try {
    return await this.#callLLM(entry, detail);
  } catch (error) {
    this.#logger.warn('Summarization failed, using fallback', { error });

    // Fallback strategy: smart truncation instead of LLM summary
    return this.#fallbackSummarize(entry, detail);
  }
}

#fallbackSummarize(entry: CommandEntry, detail: string): string {
  const lines = entry.output.split('\n');

  if (detail === 'errors_only') {
    // Extract lines containing common error patterns
    const errorLines = lines.filter(l =>
      /error|fail|exception|fatal|critical/i.test(l)
    );
    return errorLines.slice(0, 20).join('\n') || 'No obvious errors found';
  }

  // Default: first and last N lines
  if (lines.length <= 30) return entry.output;

  return [
    ...lines.slice(0, 15),
    `... (${lines.length - 30} lines omitted)`,
    ...lines.slice(-15),
  ].join('\n');
}
```

### Auto Mode Timeout

```typescript
// source/modes/companion/companion-session.ts
async *handleAutoTask(task: string): AsyncGenerator<CompanionEvent> {
  const timeout = this.#settings.get('companion.autoModeTimeout');
  const timeoutPromise = sleep(timeout).then(() => {
    throw new AutoModeTimeoutError(`Auto mode timed out after ${timeout}ms`);
  });

  try {
    // Race between completion and timeout
    for await (const event of raceAsyncIterator(
      this.#executeAutoTask(task),
      timeoutPromise
    )) {
      yield event;
    }
  } catch (error) {
    if (error instanceof AutoModeTimeoutError) {
      yield { type: 'timeout', message: 'Auto mode timed out - returning to Watch mode' };
    }
    throw error;
  } finally {
    this.setMode('watch');
  }
}
```

### Edge Cases Summary

| Scenario | Handling |
|----------|----------|
| Shell crashes | Attempt restart (max 3), then fatal error |
| AI API down | Show error message, suggest retry, remain in watch mode |
| Summarizer fails | Fall back to smart truncation |
| Auto mode timeout | Cancel operations, return to watch mode |
| Network disconnect | Detect and show offline status, queue queries |
| PTY resize during AI response | Buffer response, apply after resize complete |
| User spams ?? | Debounce queries (500ms), queue latest |
| Ctrl+C during auto | Clean abort, wait for current command, return to watch |
| Invalid shell command in auto | Report error to AI, let it recover or abort |

## Open Questions

1. **Status bar placement**: Bottom overlay vs tmux-style split?
2. **Context limits**: How many commands/tokens to keep in buffer?
3. **Multi-terminal**: Support multiple terminal sessions?
4. **Shell compatibility**: zsh, bash, fish - what to support first?
5. **Remote shells**: SSH sessions - pass through or intercept?

## Success Metrics

- User can run normal terminal commands without noticeable latency
- AI provides helpful suggestions when errors occur
- Handoff between user and AI control feels seamless
- Context is maintained across command sequences

## References

- [node-pty](https://github.com/microsoft/node-pty) - PTY implementation
- [Warp](https://www.warp.dev/) - AI terminal inspiration
- [Fig](https://fig.io/) - Terminal autocomplete patterns
