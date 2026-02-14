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
