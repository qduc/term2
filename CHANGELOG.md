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
