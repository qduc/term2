# God Object Refactor Plan: `source/lib/agent-client.ts`

*Revision 2 — incorporates review feedback*

## God Object Assessment

| Attribute | Value |
|---|---|
| **Target** | `AgentClient` in `source/lib/agent-client.ts` |
| **Candidate status** | **Yes** — strong God Object signals |
| **Lines** | 949 |
| **Private fields** | 25 |
| **Public methods** | ~18 |
| **Private methods** | ~12 |
| **Test files** | 4 separate test files due to complexity |
| **Current verification** | 76/76 tests pass across all 4 test files (36 public-methods + 20 core + 16 flex-tier + 4 chat) |
| **Existing risks** | No integration test covers the full `startStream → continueRunStream` lifecycle end-to-end; cross-cutting `#refreshAgent()` makes every setter a potential regression surface |

### Key God Object Signals

1. **Unusually large** — 949 lines, 25 private fields
2. **Many public methods** — 18+, spanning agent configuration, streaming, chat, abort, subagents, tool interception, ask-user state
3. **Mixes unrelated responsibilities** — persistence-free, but combines model configuration, runner management, agent lifecycle, tool interception, subagent management, chat, abort/correlation, settings subscription, and input filtering in one class
4. **Hard to test** — tests already split across 4 files; constructor is ~120 lines with nested factories and callbacks
5. **Constructor requires many unrelated inputs** — and wires settings subscription, subagent manager, and agent build all inline
6. **Vague name** — `AgentClient` tells you it talks to an agent, not that it also manages subagents, tool interception, ask-user answers, conversation chaining, and chat

### Not a God Orchestrator Risk (yet)

The current class owns real logic, not just sequencing. But any refactor where `AgentClient` retains all the extracted components as fields and simply delegates to them would create a God Orchestrator. The plan below avoids this by moving workflow ownership to the component that naturally owns it.

---

## Responsibilities Found

### R1. Agent Configuration & Lifecycle
- Owns: `#agent`, `#model`, `#reasoningEffort`, `#temperature`, `#provider`, `#isTransientClient`, `#editor`
- Methods: `setModel()`, `setReasoningEffort()`, `setTemperature()`, `setProvider()`, `#refreshAgent()`, `#buildFactoryDeps()`, settings subscription in constructor, initial agent build in constructor
- Reason to change: model/provider/reasoning effort setting changes; prompt changes; mode toggles

### R2. Runner Management
- Owns: `#runner`, `#maxTurns`, `#retryAttempts`, `#retryCallback`, `#serviceTierOverrideForNextRequest`
- Methods: `#createRunner()`, `#getOrCreateRunner()`, `useStandardServiceTierForNextRequest()`, `setRetryCallback()`
- Reason to change: provider runner protocol changes; retry logic changes; service tier feature

### R3. Stream/Run Orchestration
- Owns: `#currentAbortController`, `#currentCorrelationId`, `#lastChainedDeltaInputItems`
- Methods: `startStream()`, `continueRun()`, `continueRunStream()`, `#runAgent()`, `#runAgentWithProvider()`, `#filterAndGuardChainedModelInput()`, `#getAgentForRun()`
- Reason to change: agent SDK API changes; chaining logic; input filtering; prompt cache key

### R4. Tool Interception
- Owns: `#toolInterceptors`
- Methods: `addToolInterceptor()`, `#checkToolInterceptors()`
- Reason to change: interception policy changes

### R5. Subagent Management
- Owns: `#subagentManager`, `#activeSubagentsCount`, `#subagentEventSink`, `#pendingClearSink`
- Methods: `#createMentor()`, `#runSubagent()`, `setSubagentEventSink()`, `#resetMentorState()`
- Reason to change: subagent lifecycle changes; mentor model/provider changes

### R6. Ask-User State
- Owns: `#askUserAnswers`
- Methods: `setAskUserAnswer()`, `getAskUserAnswer()`
- Reason to change: ask-user answer storage changes

### R7. Chat / ChatJson
- Methods: `chat()`, `chatJson()`, `#extractResponse()`
- Reason to change: chat API changes; structured output changes

### R8. Abort & Correlation
- Methods: `abort()`, `clearConversations()`, `supportsConversationChaining()`
- Reason to change: abort semantics; correlation ID format

### Dead Code
- **`continueRun()` (non-streaming)** — zero production callers; only one unit test references it. Will be removed in Step 0.5.

---

## Wiring Decision: SubagentBridge ↔ AgentConfiguration Circularity

The original plan had a latent cycle: `#buildFactoryDeps()` (on `AgentConfiguration`) would take `SubagentBridge` as a dep, while `SubagentBridge`'s `#createMentor`/`#runSubagent` appear to need model/provider info from `AgentConfiguration`.

**Actual dependency analysis:** `SubagentBridge` does **not** need `AgentConfiguration` at runtime:
- `#createMentor` and `#runSubagent` delegate entirely to `SubagentManager.run()` / `SubagentManager.runAsTool()`
- `SubagentManager`'s constructor takes `agentClient: { chat }` and `createClient` — both are **callback functions**, not owned interfaces
- The `createClient` closure captures `deps.logger`, `deps.settings`, `deps.executionContext`, `this.#sessionContextService` — all raw constructor args, not `AgentConfiguration`

**Chosen mechanism: injected callbacks + event emission.**
- `SubagentBridge` receives `chat` and `createClient` as constructor callbacks — no `AgentConfiguration` import needed
- `AgentConfiguration`'s settings `onChange` handler emits a `configChanged` event (or calls `SubagentBridge.clearSubagentCache()` directly via an `onConfigChanged` callback injected at construction)
- Import graph stays acyclic: `SubagentBridge` ← callbacks from parent; `AgentConfiguration` → `SubagentBridge.clearSubagentCache()` via injected callback
- This is a **单向** (unidirectional) dependency: `AgentConfiguration` knows *that* something needs clearing on config change, but not *what*

---

## Proposed Target Architecture

### `ToolInterceptorRegistry`
- **Owns**: tool interceptor list and invocation logic
- **Moves**: `#toolInterceptors`, `addToolInterceptor()`, `#checkToolInterceptors()`
- **State/dependencies**: `ILoggingService` (for error logging)
- **Reason to change**: interception policy
- **Interface**:
  ```ts
  class ToolInterceptorRegistry {
    add(interceptor: ToolInterceptor): () => void;
    async check(name: string, params: unknown, toolCallId?: string): Promise<string | null>;
  }
  ```

### `AskUserAnswerStore`
- **Owns**: ask-user answer storage
- **Moves**: `#askUserAnswers`, `setAskUserAnswer()`, `getAskUserAnswer()`
- **State/dependencies**: none
- **Reason to change**: answer storage policy
- **Interface**:
  ```ts
  class AskUserAnswerStore {
    set(callId: string, answer: string): void;
    consume(callId: string): string | undefined;  // get + delete in one operation
    peek(callId: string): string | undefined;      // read without deleting
  }
  ```
  Note: the old `getAskUserAnswer(callId?: string)` accepted an optional key with implicit delete-on-read semantics — confusing because `get(undefined)` could silently return `undefined` every time. Split into `consume` (read + delete, required key) and `peek` (read only, required key). A thin compatibility delegate `getAskUserAnswer(callId?)` remains on `AgentClient` for the `ConversationAgentClient` interface.

### `SubagentBridge`
- **Owns**: subagent event sink management, active subagent count tracking, mentor session reset
- **Moves**: `#subagentManager`, `#activeSubagentsCount`, `#subagentEventSink`, `#pendingClearSink`, `setSubagentEventSink()`, `#resetMentorState()`
- **State/dependencies**: `SubagentManager` (created externally, injected); `chat` and `createClient` callbacks (injected, not `AgentConfiguration` — see [Wiring Decision](#wiring-decision-subagentbridge--agentconfiguration-circularity))
- **Reason to change**: subagent lifecycle, event routing
- **Interface**:
  ```ts
  class SubagentBridge {
    setEventSink(sink: ((event: ConversationEvent) => void) | null): void;
    clearSubagentCache(): void;         // was #resetMentorState; renamed for clarity
    readonly createMentor: (question: string) => Promise<string>;
    readonly runSubagent: (params: { role: string; task: string }, context?: unknown, details?: unknown) => Promise<SubagentResult>;
  }
  ```
  Note: `runSubagent` return type changed from `Promise<any>` to `Promise<SubagentResult>` — the actual return is whatever `SubagentManager.runAsTool()` produces, which should be typed rather than `any`.

### `RunnerManager`
- **Owns**: runner creation/caching, retry callback, service tier override, max-turns/retry-attempts config
- **Moves**: `#runner`, `#maxTurns`, `#retryAttempts`, `#retryCallback`, `#serviceTierOverrideForNextRequest`, `#createRunner()`, `#getOrCreateRunner()`, `useStandardServiceTierForNextRequest()`, `setRetryCallback()`
- **State/dependencies**: `ISettingsService`, `ILoggingService`, `ISessionContextService`, current `provider` (to key the cached runner)
- **Reason to change**: provider runner protocol, retry logic, service tier feature
- **Interface**:
  ```ts
  class RunnerManager {
    getOrCreateRunner(providerId: string): Runner | null;
    invalidateRunner(): void;           // nulls #runner; used on provider switch
    setRetryCallback(cb: () => void): void;
    useStandardServiceTierForNextRequest(): void;
  }
  ```
  Note: extracted separately from `AgentConfiguration` to avoid `AgentConfiguration` having two reasons to change (model settings AND runner/retry protocol). `AgentConfiguration` delegates runner access to this; `AgentRunOrchestrator` takes `RunnerManager` as a dep instead of reaching through `AgentConfiguration`.

### `AgentRunOrchestrator`
- **Owns**: stream/run lifecycle, abort controller, correlation ID, chained input filtering
- **Moves**: `#currentAbortController`, `#currentCorrelationId`, `#lastChainedDeltaInputItems`, `startStream()`, `continueRunStream()`, `#runAgent()`, `#runAgentWithProvider()`, `#filterAndGuardChainedModelInput()`, `abort()`, `clearConversations()`, `supportsConversationChaining()`
- **State/dependencies**: narrow `AgentSource` interface (not full `AgentConfiguration`)
- **Reason to change**: agent SDK API, streaming protocol, chaining logic
- **Interface** (depends_on: `AgentSource`):
  ```ts
  /** Narrow capability interface — prevents the orchestrator from reaching
   *  into config it doesn't own. */
  interface AgentSource {
    getAgent(sessionId?: string): Agent;
    getProvider(): string;
    getModel(): string;
  }

  class AgentRunOrchestrator {
    constructor(deps: {
      agentSource: AgentSource;
      runnerManager: RunnerManager;
      logger: ILoggingService;
      settings: ISettingsService;
    });
    abort(): void;
    clearConversations(): void;
    supportsConversationChaining(): boolean;
    startStream(userInput: ..., options?: ...): Promise<AgentStream>;
    continueRunStream(state: ..., options?: ...): Promise<AgentStream>;
  }
  ```

### `AgentChatService`
- **Owns**: simple chat and structured chat
- **Moves**: `chat()`, `chatJson()`, `#extractResponse()`
- **State/dependencies**: `AgentSource`, `RunnerManager`
- **Reason to change**: chat API, structured output schema
- **Interface**:
  ```ts
  class AgentChatService {
    constructor(deps: {
      agentSource: AgentSource;
      runnerManager: RunnerManager;
      logger: ILoggingService;
      settings: ISettingsService;
    });
    chat(message: string, options?: AgentClientChatOptions): Promise<string>;
    chatJson(message: string, options: AgentClientChatJsonOptions): Promise<unknown>;
  }
  ```

### `AgentConfiguration` (replaces model/provider/setter cluster)
- **Owns**: agent instance, model, reasoning effort, temperature, provider, transient flag, settings subscription, agent rebuild, `#buildFactoryDeps()`
- **Moves**: `#agent`, `#model`, `#reasoningEffort`, `#temperature`, `#provider`, `#isTransientClient`, `#editor`, `setModel()`, `setReasoningEffort()`, `setTemperature()`, `setProvider()`, `#refreshAgent()`, `#buildFactoryDeps()`, settings subscription, `getProvider()`, `getSettings()`, `#getAgentForRun()`
- **State/dependencies**: `ISettingsService`, `ILoggingService`, `ISessionContextService`, `ExecutionContext?`, `ToolInterceptorRegistry`, `AskUserAnswerStore`, `SubagentBridge` (via `onConfigChanged` callback — see [Wiring Decision](#wiring-decision-subagentbridge--agentconfiguration-circularity))
- **Implements**: `AgentSource` (narrow interface consumed by `AgentRunOrchestrator` and `AgentChatService`)
- **Reason to change**: model settings, provider swap, settings key changes
- **Interface**:
  ```ts
  class AgentConfiguration implements AgentSource {
    readonly model: string;
    readonly provider: string;
    getProvider(): string;
    getModel(): string;
    getAgent(sessionId?: string): Agent;
    refreshAgent(): void;
    setModel(model: string): void;
    setReasoningEffort(effort?: ...): void;
    setTemperature(temperature?: number): void;
    setProvider(provider: string): void;
  }
  ```

### `AgentClient` (temporary compatibility facade)
- **Temporary compatibility role**: thin delegate to `AgentConfiguration`, `RunnerManager`, `AgentRunOrchestrator`, `AgentChatService`, `ToolInterceptorRegistry`, `AskUserAnswerStore`, `SubagentBridge`
- **Public delegates retained**: all existing public methods
- **Logic that should no longer live here**: all of it — each method becomes a 1-line delegate
- **God Orchestrator risk**: medium during migration — mitigated by (a) making the facade strictly delegate-only with no logic, (b) updating external callers to use the target component directly over time

---

## Migration Plan

### Step 0: Establish verification baseline
- Run all 4 test files → 76/76 pass
  - `openai-agent-client.public-methods.test.ts` (36)
  - `openai-agent-client.test.ts` (20)
  - `openai-agent-client.flex-tier.test.ts` (16)
  - `openai-agent-client.chat.test.ts` (4)
- Run `npm test` for full-suite baseline
- Record any pre-existing failures

### Step 0.5: Characterization tests + dead code removal (mandatory before any extraction)
- **Remove `continueRun()` (non-streaming)** — confirmed zero production callers; only one unit test references it. Delete the method and its test case `continueRun filters replayed history to delta input when chaining from previousResponseId`.
- **Add characterization tests for the stream lifecycle** — the assessment identified no integration test covering the full `startStream → continueRunStream → abort` lifecycle. Add tests that exercise:
  1. `startStream` with chaining (`previousResponseId`) and input filtering
  2. `continueRunStream` resuming from a `RunState` with chaining
  3. `abort()` during an active `startStream` (correlation ID cleared, controller aborted)
  4. `clearConversations()` resets chained delta state
  5. `chat()` and `chatJson()` with temp provider/reasoning-effort overrides
- Run all tests

### Step 1: Extract `ToolInterceptorRegistry` (most isolated)
- Create `source/lib/tool-interceptor-registry.ts`
- Move `#toolInterceptors`, `addToolInterceptor()`, `#checkToolInterceptors()` logic
- Instantiate in `AgentClient` constructor, delegate from original methods
- Update `#buildFactoryDeps()` to pass `registry.check.bind(registry)` instead of inline closure
- Add unit tests for `ToolInterceptorRegistry` directly
- Run focused tests

### Step 2: Extract `AskUserAnswerStore` (most isolated)
- Create `source/lib/ask-user-answer-store.ts`
- Move `#askUserAnswers`; split old `getAskUserAnswer(callId?)` into `consume(callId)` and `peek(callId)`
- Instantiate in `AgentClient` constructor, delegate via compatibility method
- Update `#buildFactoryDeps()` to reference store methods
- Add unit tests for `AskUserAnswerStore` directly
- Run focused tests

### Step 3: Extract `SubagentBridge` (moderate coupling)
- Create `source/lib/subagent-bridge.ts`
- Move `#subagentManager`, `#activeSubagentsCount`, `#subagentEventSink`, `#pendingClearSink`, `setSubagentEventSink()`, `clearSubagentCache()` (was `#resetMentorState`), `#createMentor`, `#runSubagent`
- `SubagentBridge` receives `chat` and `createClient` as constructor callbacks — **no `AgentConfiguration` import**
- Instantiate in `AgentClient` constructor, delegate
- Update `#buildFactoryDeps()` to reference bridge methods
- Add unit tests for `SubagentBridge` directly
- Run focused tests + subagent-related tests

### Step 4a: Extract `AgentConfiguration` — agent build + `#buildFactoryDeps()` (pure construction)
- Create `source/lib/agent-configuration.ts`
- Move `#agent`, `#model`, `#reasoningEffort`, `#temperature`, `#provider`, `#isTransientClient`, `#editor`
- Move `#buildFactoryDeps()`, initial agent build logic, `#getAgentForRun()`
- Move `getProvider()`, `getModel()`, `getSettings()`
- `AgentConfiguration` implements `AgentSource` (narrow interface for `AgentRunOrchestrator` / `AgentChatService`)
- Inject `ToolInterceptorRegistry`, `AskUserAnswerStore`, `SubagentBridge` (via their method refs) into `#buildFactoryDeps()`
- `AgentClient` delegates config queries to `AgentConfiguration`
- Run full test suite

### Step 4b: Extract `AgentConfiguration` — setters + settings subscription + refresh coordination (behavioral)
- Move `setModel()`, `setReasoningEffort()`, `setTemperature()`, `setProvider()`, `#refreshAgent()`, settings `'onChange'` subscription
- Config-change coordination: `AgentConfiguration.#refreshAgent()` calls `SubagentBridge.clearSubagentCache()` via an `onConfigChanged` callback injected at construction — **unidirectional, no circular import**
- `AgentClient` delegates all setter methods to `AgentConfiguration`
- Run full test suite

### Step 4c: Extract `RunnerManager` from `AgentConfiguration` (keep `AgentConfiguration` single-responsibility)
- Create `source/lib/runner-manager.ts`
- Move `#runner`, `#maxTurns`, `#retryAttempts`, `#retryCallback`, `#serviceTierOverrideForNextRequest`, `#createRunner()`, `#getOrCreateRunner()`, `useStandardServiceTierForNextRequest()`, `setRetryCallback()`
- `AgentConfiguration` delegates runner access to `RunnerManager`
- `AgentRunOrchestrator` and `AgentChatService` depend on `RunnerManager` directly, not through `AgentConfiguration`
- `setProvider()` on `AgentConfiguration` calls `runnerManager.invalidateRunner()` instead of `this.#runner = null`
- Add unit tests for `RunnerManager` directly
- Run full test suite

### Step 5: Extract `AgentRunOrchestrator` (stream lifecycle — most cross-cutting)
- Create `source/lib/agent-run-orchestrator.ts`
- Move `#currentAbortController`, `#currentCorrelationId`, `#lastChainedDeltaInputItems`, `startStream()`, `continueRunStream()`, `#runAgent()`, `#runAgentWithProvider()`, `#filterAndGuardChainedModelInput()`, `abort()`, `clearConversations()`, `supportsConversationChaining()`
- Accept `AgentSource` (narrow interface) and `RunnerManager` as dependencies — **not** full `AgentConfiguration`
- `AgentClient` delegates stream methods
- `continueRun()` already removed in Step 0.5
- Add unit tests for `AgentRunOrchestrator` directly
- Run full test suite

### Step 6: Extract `AgentChatService` (chat isolated)
- Create `source/lib/agent-chat-service.ts`
- Move `chat()`, `chatJson()`, `#extractResponse()`
- Accept `AgentSource` and `RunnerManager` as dependencies
- `AgentClient` delegates chat methods
- Add unit tests for `AgentChatService` directly
- Run full test suite

### Step 7: Thin out `AgentClient` facade
- Verify `AgentClient` is pure delegation — no logic of its own
- Update key direct callers (e.g., `shell-auto-approval-evaluator.ts` → `AgentChatService` / `ShellAutoApprovalAgentClient`, `conversation-adapter.ts` → `AskUserAnswerStore`, `initial-turn-runner.ts` → `AgentRunOrchestrator`) to use target components directly where it reduces indirection
- Run full test suite

### Step 8: Optional cleanup
- Remove zero-caller delegates from `AgentClient` if external callers have migrated
- Rename `AgentClient` → deprecated alias if warranted
- Align test file naming: `openai-agent-client.*.test.ts` → `agent-client.*.test.ts` (or per-component names)
- Fix `runSubagent` return type from `Promise<any>` to `Promise<SubagentResult>` across component boundaries
- Final full test suite run

---

## Test Strategy

- **Step 0.5**: Characterization tests for stream lifecycle (mandatory, before any extraction)
- **Steps 1–3**: Focus on `openai-agent-client.public-methods.test.ts` — these test through the `AgentClient` public API and should remain green throughout. Also add direct unit tests for each newly extracted component.
- **Steps 4a–4c**: Run full test suite — AgentConfiguration, RunnerManager, settings subscription and agent rebuild affect many behaviors
- **Steps 5–6**: Run full test suite — stream lifecycle is the most used path
- **Step 7**: Run full test suite — external caller migration

---

## Unknowns & Risks

1. **`#buildFactoryDeps()` coupling** — This method ties together tool interceptors, ask-user answers, subagent methods, and the editor. It's the main cross-cluster seam. **Mitigation**: it now lives on `AgentConfiguration` with injected method refs from the other extracted components, and is split across Steps 4a (construction) and 4b (refresh coordination).
2. **Settings subscription** — The `onChange` callback in the constructor calls `#refreshAgent()` which touches the agent, subagent manager, and mentor state. After extraction, `AgentConfiguration` will own this subscription and coordinate with `SubagentBridge` via an `onConfigChanged` callback — unidirectional, no circular import. **Mitigation**: Step 4b explicitly handles this.
3. ~~**`continueRun()` (non-streaming)**~~ — Confirmed dead. Removed in Step 0.5.
4. **Constructor complexity** — The constructor builds the agent, creates `SubagentManager`, wires settings subscription, and creates the editor. **Mitigation**: Step 4 is now split into three sub-steps (4a/4b/4c) to isolate construction from behavioral coordination from runner management.
5. **Circular dependency risk** — `SubagentManager` currently creates new `AgentClient` instances via the `createClient` callback. **Mitigation**: `SubagentBridge` receives `chat` and `createClient` as constructor callbacks, not an `AgentConfiguration` reference. The dependency graph is: `SubagentBridge` ← audio callbacks (no import of `AgentConfiguration`); `AgentConfiguration` → `SubagentBridge.clearSubagentCache()` via injected callback. No circular import.
6. **`AgentSource` narrowness** — If `AgentRunOrchestrator` or `AgentChatService` need capabilities not on `AgentSource` (e.g., `supportsConversationChaining()`), the interface will widen. **Mitigation**: only add what's actually needed; revisit after Step 5.
