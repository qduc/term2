---
title: Troubleshooting & FAQ
description: Common issues, file locations, stale cache recovery, and debugging steps.
---

## File & Directory Locations

term2 stores logs, sessions, settings, and caches in platform-standard directories:

### Configuration (`settings.json`)
- **Linux**: `~/.local/state/term2-nodejs/settings.json` (or `$XDG_STATE_HOME/term2-nodejs/settings.json`)
- **macOS**: `~/Library/Logs/term2-nodejs/settings.json`
- **Windows**: `%LOCALAPPDATA%\term2-nodejs\Log\settings.json`

### Application Logs
- **Linux**: `~/.local/state/term2-nodejs/logs/` (or `$XDG_STATE_HOME/term2-nodejs/logs/`)
- **macOS**: `~/Library/Logs/term2-nodejs/logs/`
- **Windows**: `%LOCALAPPDATA%\term2-nodejs\Log\logs\`

### Conversation History
- **Linux**: `~/.local/share/term2-nodejs/conversations/` (or `$XDG_DATA_HOME/term2-nodejs/conversations/`)
- **macOS**: `~/Library/Application Support/term2-nodejs/conversations/`
- **Windows**: `%LOCALAPPDATA%\term2-nodejs\Data\conversations\`

### Model Catalog Cache
- **Linux**: `~/.cache/term2-nodejs/models/` (or `$XDG_CACHE_HOME/term2-nodejs/models/`)
- **macOS**: `~/Library/Caches/term2-nodejs/models/`
- **Windows**: `%LOCALAPPDATA%\term2-nodejs\Cache\models\`

---

## Common Issues & Solutions

### 1. Stale Model Cache

**Symptom**: Newly released models do not appear in `/model` or `--list-models`, or deprecated model names still show up.

**Fix**:
- In the CLI, run with `--refresh`:
  ```bash
  term2 --list-models --refresh
  ```
- In the interactive model picker (`Ctrl+O`), press `Ctrl+R` to force a cache refresh directly from provider APIs.
- Alternatively, remove cached model files from your platform's cache directory:
  ```bash
  # Linux
  rm -rf ~/.cache/term2-nodejs/models/*
  ```

### 2. Missing Provider Credentials

**Symptom**: `missing-credentials`, `missing-grok-login`, or `missing-codex-login` errors.

**Fix**:
- For Grok: run `term2 --grok-login`.
- For Codex / ChatGPT: run `term2 --codex-login`.
- For API key providers: check that `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, or `ANTHROPIC_API_KEY` is exported in your current shell environment, or configure it via `/settings`.

### 3. Home Directory Start Warning

**Symptom**: term2 displays a warning when started directly in `~` (your home directory).

**Explanation**: Starting term2 in your root home directory exposes your entire user tree (downloads, desktop, documents, hidden configs) to file searches and commands.

**Fix**: Navigate to a specific project directory (`cd ~/projects/my-app && term2`) before launching. If you only need to run administrative commands in your home directory, start with `term2 --lite`.

### 4. Non-Interactive Tool Execution Fails

**Symptom**: Running `term2 "do something that writes a file"` outputs text but makes no modifications.

**Explanation**: In non-interactive mode, tool execution is disabled by default for safety because no human is present to confirm actions.

**Fix**: Pass `--auto-approve`:
```bash
term2 --auto-approve "Fix the typo in README.md"
```

### 5. Web Gateway Port or Socket Conflicts

**Symptom**: `term2 serve` reports that the socket or port is already in use.

**Fix**:
- Check if an existing gateway instance is running:
  ```bash
  ps aux | grep "term2 serve"
  ```
- Remove an orphaned socket file if no process is holding it:
  ```bash
  rm ~/.local/state/term2-nodejs/gateway/gateway.sock
  ```
