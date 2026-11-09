---
title: Authentication & OAuth
description: Authenticating term2 using API keys and browser-based PKCE OAuth.
---

## Browser PKCE OAuth

Sign in to Codex or Grok in your browser. After signing in, use `term2 --model` or `/model` to choose a model from that provider. Your account’s billing and usage limits apply.

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

API keys can be provided through environment variables. Direct Anthropic and Gemini access also requires a custom provider entry through `/providers` or settings; the variable alone does not register an adapter. See [provider setup](/term2/providers/).

| Provider | Environment Variable |
| :--- | :--- |
| **OpenAI** | `OPENAI_API_KEY` |
| **OpenRouter** | `OPENROUTER_API_KEY` |
| **Anthropic** | `ANTHROPIC_API_KEY` |
| **Google Gemini** | `GOOGLE_GENERATIVE_AI_API_KEY` |
| **Tavily (Web Search)** | `TAVILY_API_KEY` |
| **Exa (Web Search)** | `EXA_API_KEY` |

## Persisting Credentials in Settings

Use `/settings` to save an API key in `settings.json`.

```bash
# In interactive session:
/settings agent.openai.apiKey sk-...
/settings agent.openrouter.apiKey sk-or-v1-...
```

These keys are plaintext in `settings.json` (not guaranteed mode `0600`), and the standard sandbox does not deny term2's settings/OAuth paths. Prefer environment variables or OAuth for credentials.
