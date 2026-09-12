---
title: Authentication & OAuth
description: Authenticating term2 using API keys and browser-based PKCE OAuth.
---

## Browser PKCE OAuth

term2 supports official browser-based PKCE OAuth logins for OpenAI Codex / ChatGPT and xAI Grok. This lets you use your existing subscription without managing API keys or creating billing accounts.

### Logging in to Grok

```bash
term2 --grok-login
```

1. term2 starts a temporary local loopback callback server.
2. Your default browser opens the authentication page.
3. Once you sign in and authorize, tokens are stored under `envPaths('term2').config` (for example `~/.config/term2-nodejs/` on Linux, or macOS Preferences), not the settings state/log directory. `TERM2_CONFIG_DIR` overrides this location. The credential file is created mode `0600` in its configuration directory; protect that directory as well.
4. If running in a headless or remote SSH session where a browser cannot open, use a TTY (`ssh -t`). Copy the redirected URL from your browser's address bar, paste it into the terminal prompt, and press `Enter`; paste input is ignored when stdin is not a TTY.

### Logging in to Codex / ChatGPT

```bash
term2 --codex-login
```

Follow the browser prompt to log in with your ChatGPT account.

### Multi-Account Management

When multiple OAuth accounts exist for a provider:
- Open the `/providers` menu in an interactive session.
- Select the provider to view connected accounts.
- Choose which account to make active.

## Environment Variables (API Keys)

API keys can be provided through standard environment variables:

| Provider | Environment Variable |
| :--- | :--- |
| **OpenAI** | `OPENAI_API_KEY` |
| **OpenRouter** | `OPENROUTER_API_KEY` |
| **Anthropic** | `ANTHROPIC_API_KEY` |
| **Google Gemini** | `GOOGLE_GENERATIVE_AI_API_KEY` |
| **Tavily (Web Search)** | `TAVILY_API_KEY` |
| **Exa (Web Search)** | `EXA_API_KEY` |

## Persisting Credentials in Settings

You can also store API keys permanently in your `settings.json` via the `/settings` menu or by setting:

```bash
# In interactive session:
/settings agent.openai.apiKey sk-...
/settings agent.openrouter.apiKey sk-or-v1-...
```

Keys stored in `settings.json` persist across shell sessions and reboot cycles.

These keys are plaintext in `settings.json` (not guaranteed mode `0600`), and the standard sandbox does not deny term2's settings/OAuth paths. Prefer environment variables or OAuth for credentials.
