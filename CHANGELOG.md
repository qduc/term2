## [0.9.1] - 2026-06-26

### Features
- Add `/retry tool` command that rewinds to the last tool output, trims the trailing assistant/system UI tail, and replays the model from the preserved tool-result history
- Redesign tool call display in UI
- Add refresh functionality to model selection and input handling
- Enhance `search_replace` with detailed command message formatting
- Enhance `glob` tool to support absolute path patterns and improve error handling
- Add sandbox read policy display to StatusBar component
- Add line numbers to `read_file` tool output
- Adjust `grep` and `glob` tool output to reduce confusion and improve clarity
- Add sandbox XDG directory redirection
- Improve sandbox prompts and clarify temp directory location in sandbox messages

### Bug Fixes
- Fix finished subagent messages retaining in dynamic rendering area causing flickering
- Fix log files not being cleaned up properly
- Fix next turn not working correctly after aborting
- Fix lost user message after aborting
- Fix stale images callback in InputBox component
- Fix redundant marginY from CommandMessage tool panels
- Fix UI not reflecting post-retry tool state

---

## [0.9.0] - 2026-06-23

### Features
- Add sandboxed shell execution with configurable read policy levels (`credential-denylist`, `home-denylist`, `standard`, `strict`)
- Add sandbox write protection with filtered path logging
- Add sandbox temp directory management for consistent temporary file handling
- Add denied read approval UX for sandbox filesystem access
- Add unsandboxed shell approval support in ApprovalPrompt
- Rename `find_files` tool to `glob` for clarity
- Show approval prompt when reading outside workspace instead of denying access
- Allow using custom model names not in the predefined list
- Sanitize and detect malformed tool call arguments in conversation history
- Optimize token input handling for improved performance
- Increase default max tool output size from 10k to 40k characters
- Enhance skill discovery paths for better workspace resolution

### Bug Fixes
- Fix missing tool outputs in stateless full-history fallback causing HTTP 400 errors
- Fix ghost dotfiles not being cleaned up properly
- Fix model selection not working in handoff flow
- Fix duplicate text appearing in non-interactive mode

---

## [0.8.0] - 2026-06-20

### Features
- Add skills support with `/skills` command to browse and manage available skills
- Implement batch-barrier approval flow for parallel tool calls
- Add structured `ask_user` tool with multi-question navigation, multi-select choices, typed answers, and decline option
- Add reasoning effort selection in handoff flow
- Add plan mode exit reminder when running handoff command
- Add concise display mode for compact tool output rendering
- Add UI indicator for tool call streaming
- Add shell output formatting with truncation handling and execution duration tracking
- Display first paragraph of tool output when commands complete
- Add rate-limit middleware to handle 429 responses with excessive `retry-after` headers
- Add WebSocket-to-HTTP downgrade support for conversation chaining
- Add `overwrite` parameter to `create_file` tool
- Add `match_all` parameter to `search_replace` tool
- Add reasoning metadata retention in message processing and WebSocket response payloads
- Add `PROVIDER_ORDER` support in settings with provider reordering functionality
- Add resume state handling for continuation of streaming conversations
- Add `grep` case sensitivity, regex/literal mode options, and strict JSON parsing

### Bug Fixes
- Fix inability to write outside workspace after approval
- Fix missing tool output in response to Codex API
- Fix missing `reasoning_content` after interrupted turns
- Fix `undefined` value handling for `confirmOverwriteCode` in `create_file` tool
- Fix fetch models error for Gemini
- Fix out-of-order rendering and duplication of committed messages
- Fix prompt-cache prefix break after `max_turns_exceeded` continuation for full-history providers
- Fix completed subagent messages disappearing in UI while waiting for parallel subagents
- Fix tool call streaming indicator missing for Anthropic/Gemini providers
- Fix concise mode regression where query patterns failed to render
- Fix chaining request not working properly for Codex
- Fix tool chaining and input filtering for conversation continuity
- Fix non-string/object JSON array items handling in tool output warnings
- Fix input surge guard false positive block on approval continuation retries
- Fix cursor position issues in input when value and cursor override change simultaneously
- Fix wrong cursor position when selecting setting items
- Fix text color handling for approval rejections and error messages
- Fix interleaved tool outputs and delta filtering in Codex responses
- Fix missing `turnId` in conversation sessions
- Fix subagent turn count increment in context handling
- Fix transient retry handling to preserve conversation chaining instead of permanently disabling it

## [0.7.3] - 2026-06-04

### Features
- Add delta-input filtering for conversation chaining to prevent duplicate inputs
- Add `getMaxOutputTokens` utility with dynamic token limits integrated into Anthropic provider
- Support conversation history chaining for Codex over WebSocket
- Add `prompt_cache_key` forwarding to OpenAI WebSocket requests
- Add `modelClass` and `modelWrapperClass` metadata to logging and provider traffic records
- Add headers to traffic log entries
- Add hardened `ask_user` tool with improved clarity and usage consistency
- Add field-level validation errors and discard confirmation flow for provider settings
- Add providers management menu for configuring multiple API providers
- Enable explorer subagent to run safe read-only shell commands
- Refine orchestrator mode prompt for better task delegation
- Support free-form string settings with runtime modification
- Add inactive state support to menu items and improve navigation handling
- Add safeguards and user confirmation prompt when starting non-lite mode from home or root directory
- Improve settings handling with schema-based validation, persistence, and numeric suggestions
- Add notification mechanism for main agent and subagents approaching maximum turn limits
- Improve inline completion cancellation and dismissal tracking
- Limit number of path completion entries to avoid performance issues
- Deliver plan mode toggle as a prefixed user-turn notice
- Sanitize `system` field in sent traffic data with truncation support

### Bug Fixes
- Fix chaining continuity issues and improve undo tool ledger logic
- Fix maxOutputTokens fallback to 4096 for non-Claude models
- Fix false positive from wrapToolInvoke scanning result strings for error types
- Fix corrupt tool display for resumed conversations
- Fix active prompt label wrapping for long input content
- Fix prompt token estimates
- Fix cannot leave empty handoff message (fallback to default now works)
- Fix completed commands stuck in dynamic render queue
- Fix already billable token usage handling in accumulators
- Update token prop in LargeUncachedConfirmationPrompt for consistency

### Improvements
- Refactor ask_user tool guidance for clarity and improved usage consistency
- Remove redundant "Decline to answer" instruction from ask_user tool description
- Extract provider middleware and session handling into dedicated modules
- Decouple session context management from LoggingService
- Extract warning injection logic from trim-tool-output.ts
- Streamline notification send method
- Improve command-safety classifications

### Internal/Chores
- Cleanup various code smells
- Improve sidebar in log viewer to work with complex multi-file nested structures

## [0.7.2] - 2026-05-31

### Features
- Add `maxParallelToolCalls` runtime setting for configuring parallel tool execution
- Add notification support when agent needs approval or finishes a task
- Display usage data (token counts) when resuming a conversation
- Enhance focus handling and input sequence fixes
- Add robust large uncached input handling with confirmation prompt
- Enhance handoff flow with dynamic message prompts and input handling
- Implement lazy-load to reduce memory usage
- Improve conversation filtering and error handling in `--resume ls`
- Add function to strip RTK's "No hook installed" warning from stderr output

### Bug Fixes
- Fix render performance issue when resuming conversation
- Fix wrong token usage display and token estimation in large uncached input warning
- Prevent truncation when saving conversation
- Fix streamed transient retries to preserve completed tool-call progress for non-chaining providers
- Fix retry command to correctly send back tool calls after user message
- Fix StatusBar time display for resets within 24 hours
- Fix fallback responses crash when missing `output` in WebSocket responses
- Fix memory leak
- Fix GPT prompts to follow Codex guidelines

### Improvements
- Rename `estimatedTokens` to `accumulatedInputTokens` in LargeUncachedConfirmationPrompt for clarity
- Split language providers per file and add more language definitions
- Remove title and headerRight props from multiple selection menus for cleaner UI
- Replace `writeBoundary` with `tags` in schemas and update related tests
- Cache custom provider instance to improve model retrieval performance

### Internal/Chores
- Bump `ink-prompt` to v0.3.0
- Add regression test for lazy provider instance reuse across `getModel` calls

## [0.7.1] - 2026-05-29

### Features
- Introduce `TimedResponsesWSModel` with configurable timeouts and enhanced WebSocket error handling
- Add `firstFrameTimeoutMs` for configurable WebSocket connection timeouts
- Improve WebSocket error handling with close code and reason tracking
- Add automatic retry for transient WebSocket 1006 connection closures
- Add `--resume ls` and metadata-rich conversation listing for session management
- Implement OSC 52 clipboard support for improved SSH clipboard handling
- Add `assistant_turn` events and persisted turn item support for more robust conversation replay
- Handle reasoning in `rawContent` for persisted turn items, improving reasoning round-trip across sessions
- Enhance continuation handling and logging in conversation sessions
- Add large uncached input warnings and confirmation prompts in the status bar
- Enhance error logging with stack traces and improved formatting
- Enhance `/undo` and `/retry` commands to handle image attachments
- Add `parentTool` to `subagent_started` events for mentor subagent parent tracking
- Handle mid-turn interruptions and incomplete tool batches during conversation replay
- Extend `apply_patch_call` support and improve argument normalization
- Enhance tool execution ledger and conversation session state management for recovery
- Adjust Codex provider request timeout and retry policy
- Tab-completing `/undo` now opens the undo selection menu directly

### Bug Fixes
- Fix missing `rawContent` in replayed reasoning items during conversation restoration
- Fix conversation store history duplication after interrupted tool batches
- Fix reordered full-snapshot supersets being incorrectly accepted in `updateFromClient`
- Fix missing or empty terminal response output in `CodexResponsesModel`
- Fix `use-conversation` logging stack property leaked through `rawEvent`
- Fix flaky test suite: resolve race conditions, timing sensitivity, and open handles
- Increase default timeout for edit healing model

### Improvements
- Refactor conversation event logging: replace `assistant_final` with `assistant_turn` and streamline session logging
- Optimize project tree rendering with breadth-first search for improved performance
- Remove mode notice handling and related code for clarity
- Remove `writeBoundary` parameter from subagent definitions
- Remove redundant recovery message checks from conversation replay and tool execution tests
- Improve patch error messages for clarity and consistency
- Centralize WebSocket timeouts in `DEFAULT_TIMED_WS_TIMEOUTS`
- Simplify `ConversationStore` API with identity-aware merge strategy
- Refactor app commands hook for cleaner structure
- Rename `OpencodeMinimaxHybridProvider` to `OpencodeAnthropicFormatProvider`
- Use system temp directory for test files and add cleanup logic
- Streamline assistant guidelines and update test command in package.json

### Internal/Chores
- Remove unused `CODEX_REQUEST_TIMEOUT_MS` and `CODEX_MAX_RETRIES` constants
- Remove file reference guidelines from GPT-5 prompt
- Update `SHELL_AUTO_APPROVAL_PROMPT_VERSION` to v5 and refine approval prompt
- Update readme and AGENTS.md

## [0.7.0] - 2026-05-26

### Features
- Add `/handoff` command and workflow for transferring assistant responses between sessions
- Add `/retry` command to re-send the last user message
- Implement event-log conversation persistence for reliable session saving and resumption
- Add tool execution ledger for stream failure recovery
- Implement project tree generation with custom ignore rules and limits
- Add Codex rate limit information display in the status bar
- Introduce `auto`, `on`, and `off` options for `searchViaShell` setting
- Add reasoning efficiency guidance to system prompts
- Enhance subagent recoverable error handling and retry logic
- Add `callId` field to message types for better message tracking
- Implement `switchProvider` with safety guard for runtime provider changes
- Add `large-uncached-input` guard to prevent excessive input sizes
- Handle truncated events during conversation replay
- Sanitize nested subagent results in conversation logs
- Enhance `apply-patch` error reporting for invalid diffs and context mismatches
- Add `combineAbortSignals` utility for improved tool execution control
- Enrich error context with event details for better debugging
- Add duplicate tool call/result pair detection and warnings in streams
- Ensure stable fallback session ID for opencode across turns
- Integrate traffic context session ID for opencode headers
- Cache model instances in Opencode provider for efficiency
- Resolve and apply default reasoning level for Codex models

### Bug Fixes
- Fix undo not working correctly when there is an error on the last turn
- Fix newline dropped when emitting reasoning delta in stream event processor
- Fix stale path entries not being refreshed in `use-path-completion`
- Fix rejected commands not being preserved during message extraction
- Fix approval-rejected commands not rendering correctly in the UI
- Fix Codex rate limit handling and provider reset behavior
- Fix rate limit extraction and StatusBar rendering for Codex
- Fix input-box handling of direct command triggers vs settings menu
- Fix prompt test suite

### Improvements
- Centralize error description with `describeError` and enhance retry logic
- Deduplicate `tool_started` events and normalize tool call arguments
- Replace `writeLastPointer` with `saveLastConversation` for more robust persistence
- Extract match context and approval logic into utility functions for `search-replace`
- Improve category lookup and test coverage in settings
- Add `onReset` option to `useSettingsValueCompletion` and refactor reset handling
- Track subagent usage and integrate into session management
- Introduce prompt profiles and restructure prompt selection
- Add modular middleware and session handling for OpenAI-compatible providers
- Simplify token refresh logic in Codex provider
- Refactor `useSelection` state handling and stabilize tests
- Include plan-mode-info in standard mode for cache stability
- Clarify and expand Plan Mode drafting requirements in docs

## [0.6.1] - 2026-05-23

### Features
- **SSH session resumption**: Resume SSH sessions with `--resume`, including full SSH options support in the resume command.
- **Session archiving**: Cleared conversations are now archived and assigned a fresh session ID, preserving history without cluttering the active session.
- **Subagent auto-approval**: Shell commands rated YELLOW (low-risk) are now auto-approved when issued by subagents, reducing interruptions during delegated tasks.
- **Flex tier retry**: Automatically retries requests when the flex tier fails.
- **OpenRouter reasoning**: Reasoning details in OpenRouter API requests are now preprocessed for improved compatibility.
- **Conversation history repair**: Automatic cleanup and optimization of conversation history to recover from corrupted or oversized state.

### Bug Fixes
- Fixed incorrect model sort order when a filter is active.
- Fixed missing task context when subagents request auto-approval, restoring correct approval decisions.

### Improvements
- Plan Mode and Subagent Delegation instructions are now only included in the system prompt when those modes are active, reducing token usage.
- Shell command auto-approval evaluations now use structured output and caching for faster, more consistent decisions.
- Provider traffic logs reorganized into a flat per-day folder layout with millisecond-precision timestamps and key-value labels for easier querying.

## [0.6.0] - 2026-05-21

### Features
- **Orchestrator mode**: New mode that delegates tasks to specialized subagents with shell access for complex multi-step work
- **Plan mode**: Read-only mode for researching and proposing step-by-step implementation plans before making changes
- **Undo / Rewind**: Select any past user message and rewind the conversation to that point
- **Conversation persistence**: Automatically save and resume sessions with `--resume`; conversations are now project-aware
- **Slash command completion**: Tab-complete slash commands from the input field
- **Anthropic prompt caching**: Reduced latency and cost when using Anthropic providers
- **Provider override**: Specify a provider directly via CLI flag with validation
- **OpencodeMinimaxHybrid provider**: New provider option for hybrid routing
- **Web-fetch improvements**: Large results saved to a temp file instead of being truncated in context
- **Enhanced undo**: ESC key resets input and mode in contextual states; terminal redraws correctly after undo
- **Settings menu**: Stays open after changing a setting so you can adjust multiple options without reopening
- **Grep enhancements**: File pattern filtering and improved charset handling for binary-safe output
- **Input surge guard**: Detects and blocks abrupt message growth or replayed tool-call histories to prevent runaway loops
- **Subagent editing model**: Subagents can now prefer a dedicated editing model for file operations
- **Task preview**: Longer previews with smarter truncation for subagent task descriptions

### Bug Fixes
- Fixed undo not working when using the Responses API (chaining provider)
- Fixed history navigation (up-arrow) losing image attachments
- Fixed plan mode incorrectly prompting for approval on edit tools
- Fixed prompt cache breaking when exiting plan mode
- Fixed errors from input surge guard not surfacing in the UI
- Fixed failed user messages not being cleaned up on non-retryable provider errors
- Fixed reasoning blocks being dropped before pending or running tool calls
- Fixed stream cancellation not being handled correctly in the event processor
- Fixed newline normalization between code fences and the first line of code
- Fixed `cwd` missing from environment info in lite mode
- Fixed strict providers rejecting messages with a stray `index` field

### Improvements
- Simplified file editing: standard mode now allows writing anywhere in the workspace by default, removing the separate "edit mode"
- Subagents now respect abort signals so cancellation propagates cleanly through delegated runs
- Non-interactive mode has stricter security defaults
- Streaming reasoning and text deltas are logged to stderr for easier debugging
- Reasoning-efficiency guidance added to prompts to reduce unnecessary thinking steps

## [0.5.0] - 2026-05-18

### Features
- **Subagents**: Added subagent support with real-time activity rendering, token usage tracking, and dynamic role descriptions
- **Clipboard command**: Added `/clipboard` command with async support
- **Reasoning cancellation**: Added cancellation and finalize handling for reasoning deltas

### Bug Fixes
- Fixed blank lines being stranded mid-history during chunked reasoning
- Fixed markdown heading depths and spacing being lost in streaming/continuation messages
- Fixed double-counting in token usage tracking for multi-turn tasks
- Fixed token usage counting across streamed turns

### Improvements
- Improved search-replace tool to reject identical search and replace content
- Improved command safety: external paths now require approval; temporary directories handled safely
- Replaced `bash-parser` with `unbash` for more reliable command parsing and safety
- Improved prompt cache control targeting for compatible models
- Token usage now merged across auto-approved and continuation events

## [0.4.0] - 2026-05-16

### Features

- **Token usage tracking and reporting** — Session token usage is now tracked and propagated through the approval flow with billable calculations
- **Code context tools** — New code searching capabilities with multi-language support for better code exploration
- **apply_patch tool** — Direct support for applying patches to files
- **Reasoning formatting** — Reasoning and streaming text now rendered with Markdown formatting for better readability
- **Auto-healing enhancements** — Improved auto-healing with detailed failure reasons and extended recovery capabilities
- **File batch operations** — Support for parallel edits with file locking utilities
- **Slash command additions** — New `/effort` slash command for configuring reasoning effort levels
- **Provider expansion** — Anthropic and Google now available as first-class provider types; OpenCode provider added with session headers
- **Search tool improvements** — Search output now uses plain-text format for better efficiency; added `no_ignore` option for search and file tools
- **Settings enhancements** — Support for optional `baseUrl` configuration in providers; current setting values now highlighted in suggestions
- **Cache control** — Prompt cache now applied to last two messages for extended context preservation

### Bug Fixes

- **Dotfiles in file matching** — Dotfiles are now properly included in file matching operations
- **Conversation event handling** — Fixed flushing and correction issues in conversation event processing
- **Batched replacements** — Improved error handling and increased edit-healing timeout
- **Reasoning text persistence** — Fixed reasoning text being reset when restarting after tool execution
- **Shell command handling** — Fixed hanging issue with shell commands expecting stdin input
- **Rendering improvements** — Better fallback rendering in shell prompts and approval flows
- **Layout fixes** — Fixed horizontal padding alignment between static and active message sections; improved table layout width propagation
- **Provider configuration** — Fixed support for empty `apiKey` in provider configuration

### Improvements

- Enhanced token usage extraction and caching logic
- Improved command safety inspection and path analysis
- Better message streaming with streamlined status bar alignment
- OpenAI-compatible message sanitization for improved compatibility
- Optimized settings menu with scrollable result list and better filtering
- Disabled OpenAI agents tracing globally by default for reduced overhead

## [0.3.1] - 2026-05-10

### Features
- Add OpenRouter provider support via AI SDK integration
- Normalize assistant reasoning handling across AI SDK models
- Add reasoning-delta event streaming support for improved real-time reasoning output

### Bug Fixes
- Fix incorrect model list loading when rapidly switching between providers

## [0.3.0] - 2026-05-10

### Features
- Support image pasting in the terminal
- Add configurable paste threshold setting
- Vercel AI SDK integration for additional provider support

### Bug Fixes
- Fix models endpoint path for OpenAI-compatible providers

### Improvements
- Improve table column width calculation and terminal wrapping
- Ensure table borders adapt to terminal width and align with rows

## [0.2.0] - 2026-05-08

### Features
- Model setting configurations and provider handling for edit-healing
- Exa search provider integration
- `/copy` command to copy the last assistant message
- `/auto-approve` slash command with enhanced StatusBar UI
- Shell command auto-approval advisory mode with LLM-based safety evaluation and configurable settings
- Auto-approval system with batch evaluation, caching, and leaderboard functionality
- Auto-approval evaluator with YAML-based multi-provider/model configuration
- Severity-weighted scoring and wrong-approval penalty in leaderboard calculations
- Prompt version handling for improved result tracking
- Current date in system prompt
- Default path for `--models-file` with improved model runs validation

### Bug Fixes
- Fixed reasoning_content not included when using openai-compatible providers
- Fixed stale closures in keyboard handlers and provider switching
- Ensured reasoning_content correctly replaces reasoning in openai-compatible tests and model logic

### Improvements
- Table rendering with word wrapping and width constraints
- Enhanced command safety classification and advisory logic for improved risk assessment
- Improved logging for openai-compatible providers
- Unified traffic log structure with simplified cleanup logic
- Shell auto-approval evaluator with compact history context and truncation logic
- Command search results now prioritized and sorted alphabetically
- Reduced noisy logs throughout the application
- Decoupled business logic and state management from main UI component
- Decomposed ConversationSession into focused collaborator modules
- Enhanced error handling and retry logic for rate-limited operations

### Internal/Chores
- Tests refactored to improve maintainability and coverage
- Extracted shared selection logic into useSelection hook
- Refactored approval rejection interceptor with comprehensive tests
- Refactored InputBox into focused hooks and pure helpers
- Replaced async result promises with async generators in conversation session flow
- Upgraded @openai/agents, ink, and ink-prompt dependencies

## [0.1.8] - 2026-02-14

### Features
- Dynamically calculate input box width based on current mode and terminal size
- Introduce `usage_update` event to provide real-time token usage during streaming
- Implement JSON repair for tool inputs and expand model error recovery with explicit error context
- Implement gap matching in the search-replace tool, allowing `<...>` in `search_content` to skip intermediate text
- Enable DEC Mode 2026 synchronized output to prevent terminal flickering during Ink rendering by patching `process.stdout`

### Bug Fixes
- Fix tilde operator (~) not expanding to home directory in path parameter of tools

### Internal/Chores
- Implement conversation flow refactor
- Add resume functionality to the release script
- Update documentation

## [0.1.7] - 2026-02-09

### Bug Fixes
- Normalized tool call name before emitting to agent runtime
- Make defaulted tool params optional and fix OpenAI strict schemas
- Refine changelog generation to exclude markdown code blocks and comments

### Internal/Chores
- Cleanup changelog

## [0.1.6] - 2026-02-09

### Features

- Improve message logging with enhanced logging contract and trace taxonomy
- Improve log viewer UI with debugging upgrades
- Add non-interactive mode for CLI usage

### Bug Fixes

- Clear token usage when running /clear command

### Improvements

- Use provider capabilities for better provider abstraction
- Refine apply_patch approval prevalidation behavior
- Reset mentor state when rebuilding main agent

### Internal/Chores

- Extract prompt selector for cleaner separation of concerns
- Extract approval state holder for better state management
- Extract command message streaming helper for reusability
- Extract stream event parsing helpers for maintainability
- Unify CommandMessage type across codebase
- Centralize tool name constants
- Extract streaming session factory for dependency injection
- Decompose settings service for better modularity
- Add conversation integration test coverage for stream, approval, and retry scenarios
- Set up Husky and lint-staged for pre-commit code formatting with Prettier
- Update coding style to follow industry standards

## [0.1.5] - 2026-02-07

### Features

- Display token usage in conversations
- Add a global tool-output character cap to limit output verbosity

### Bug Fixes

- Show error when fetching model fails instead of silently skipping it
- Fix reject flow with Esc key producing incorrect message history
- Fix schema validation issues
- Trim whitespaces in command arguments
- Handle SSH find_files patterns without fd utility

### Improvements

- Refactor: Extract web-fetch to standalone package for reusability

### Internal/Chores

- Update README documentation

## [0.1.4] - 2026-01-30

### Features

- Add web_fetch tool for fetching and processing web content
- Implement AI-powered healing for malformed edit patches
- Add conversion of GitHub file URLs to raw links for improved accessibility
- Implement EOL normalization and comment stripping for search/replace tool
- Use incremental rendering to reduce flickering and improve performance

### Bug Fixes

- Fix issue where RED level commands were hard-blocked even after user approval
- Merge consecutive messages with the same role before sending to API
- Update text colors for better visibility and consistency across components
- Ensure npm authentication before publishing in release script

### Improvements

- Update changelog generation to use Haiku model for improved output quality
- Refactor use-conversation hook and improve test coverage

### Internal/Chores

- Bump Ink version to 6.6.0
- Add planning for GitHub Copilot SDK as provider

## [0.1.3] - 2026-01-28

### Features

- Add normalized whitespace matching to search-replace tool
- Modified ESC key behavior in settings menu to step back one level at a time instead of closing completely
- Add 'flex' service tier for OpenAI provider
- Fetch fresh project context when starting a new conversation
- Redesign and revamp settings menu to improve UX

### Bug Fixes

- Display create_file tool approval in clean format, consistent with other tools
- Fix read_file tool test
- Fix mentor usage with different provider than main model
- Fix tool schema issues
- Fix type errors from new SDK version
- Allow custom values for number-based settings
- Make tool definitions strictly compliant with OpenAI's "Structured Outputs" requirements
- Update text and reasoning colors for better visibility
- Fix markdown blockquote renderer wrapping block-level elements inside Text component

### Improvements

- Enhance read_file tool output to be clearer
- Enhance release script with health checks and final verification

### Internal/Chores

- Update OpenAI Agents SDK to 0.4.3

## [0.1.2] - 2026-01-23

### Features

- Modified ESC key behavior in settings menu to step back one level at a time instead of closing completely
- Add 'flex' service tier for OpenAI provider
- Fetch fresh project context when starting a new conversation
- Redesigned settings menu with improved UX
- Enhanced release script with health checks and final verification

### Bug Fixes

- Allow custom values for number-based settings
- Tool definitions now strictly compliant with OpenAI's "Structured Outputs" requirements
- Update text color for better visibility
- Update reasoning text color for better visibility
- Markdown blockquote renderer no longer wraps block-level elements inside Text components

### Internal/Chores

- Fix tests

# Changelog

## [0.1.1] - 2026-01-20

### Features

- Add create file tool
- Add web search tool to agent definition

### Bug Fixes

- Fix reasoning content not displaying for OpenAI-compatible providers
- Fix tools to work outside of workspace in lite mode

### Improvements

- Refactor mentor mode prompt
- Update lite prompt documentation

### Internal/Chores

- Add release script
- Update README documentation
