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
