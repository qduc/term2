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
