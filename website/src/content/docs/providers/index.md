---
title: Providers Overview
description: Supported providers, models, and custom endpoint integration.
---

term2 features a provider-neutral model layer supporting major commercial LLM APIs, browser OAuth logins, and local endpoints.

## Built-in Providers

The following providers are registered natively and selectable directly via the `-p` CLI flag:

| Provider | Identifier (`-p`) | Connection Method | Auth Mechanism | Notes |
| :--- | :--- | :--- | :--- | :--- |
| **OpenAI** | `openai` | WebSocket Responses / Chat Completions | `OPENAI_API_KEY` or `agent.openai.apiKey` | Default provider. Supports native server-side context management. |
| **ChatGPT / Codex** | `codex` | WebSocket Responses | PKCE OAuth (`term2 --codex-login`) | Direct login with ChatGPT subscription credentials. |
| **xAI Grok** | `grok` | Responses API | PKCE OAuth (`term2 --grok-login`) | Encrypted reasoning tokens round-tripped with full continuity. |
| **OpenRouter** | `openrouter` | HTTP Streaming | `OPENROUTER_API_KEY` or `agent.openrouter.apiKey` | Unified gateway to Claude, Gemini, DeepSeek, Llama, and hundreds more. |

## Custom Configured Providers (Anthropic, Gemini, Local Models)

Anthropic and Google Gemini are supported through runtime custom provider adapters (`KNOWN_CUSTOM_PROVIDER_TYPES`), rather than fixed built-in `-p` identifiers. To use direct Anthropic or Google Gemini models (or local models like Ollama / llama.cpp), add them to the `providers` list in `settings.json` or configure them via the interactive `/providers` menu:

```json
{
  "providers": [
    {
      "name": "Anthropic",
      "type": "anthropic",
      "apiKey": "sk-ant-..."
    },
    {
      "name": "Google Gemini",
      "type": "google",
      "apiKey": "..."
    },
    {
      "name": "Local Ollama",
      "type": "openai-compatible",
      "baseUrl": "http://127.0.0.1:11434/v1"
    },
    {
      "name": "Local llama.cpp",
      "type": "llama.cpp",
      "baseUrl": "http://127.0.0.1:8080/v1"
    }
  ]
}
```

- **Environment variables**: When configured, custom provider adapters also load credentials from `ANTHROPIC_API_KEY` or `GOOGLE_GENERATIVE_AI_API_KEY`.
- **OpenRouter alternative**: You can also use Anthropic Claude and Google Gemini models immediately without custom provider configuration via the built-in `openrouter` provider (`-p openrouter`).
- **Loopback endpoints**: Local endpoints (`127.0.0.1`, `localhost`, `::1`) do not require API keys.


## Managing Providers Interactively (`/providers`)

Run `/providers` in any interactive session to open the Provider Manager:
- List active and available providers.
- Add new custom endpoints.
- Edit existing connection settings (Base URL, API keys).
- Switch active accounts when multiple OAuth accounts are configured.
- Remove custom providers.

## Custom OpenAI-Compatible Endpoints

You can register custom providers via the `/providers` menu or directly in `settings.json`:

```json
{
  "providers": [
    {
      "name": "Local Ollama",
      "type": "openai-compatible",
      "baseUrl": "http://127.0.0.1:11434/v1"
    },
    {
      "name": "Local llama.cpp",
      "type": "llama.cpp",
      "baseUrl": "http://127.0.0.1:8080/v1"
    }
  ]
}
```

Loopback endpoints (`127.0.0.1`, `localhost`, `::1`) are treated as local and do not require API keys. Remote endpoints can specify an optional `apiKey`.
