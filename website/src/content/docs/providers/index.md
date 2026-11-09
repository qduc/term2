---
title: Providers Overview
description: Built-in model providers and how to add a custom endpoint.
---

Choose a provider, connect its account or API key, and select one of its models. If you are new to term2, follow the [first-run guide](/term2/getting-started/first-run/) for a complete walkthrough.

## Connect a provider

- **ChatGPT / Codex:** Run `term2 --codex-login`, then select a Codex model.
- **OpenAI API:** Set `OPENAI_API_KEY` in the shell where you start term2, then select an OpenAI model.
- **Grok:** Run `term2 --grok-login`, then select a Grok model.
- **OpenRouter:** Set `OPENROUTER_API_KEY`, then select an OpenRouter model. This also gives access to models from other vendors.
- **Anthropic, Gemini, or a local server:** Add a custom provider using `/providers` or the configuration example below. Setting an environment variable alone does not register it.

In an interactive session, use `/providers` to manage connections and `/model` to choose a model. See [authentication](/term2/providers/authentication/) for more details.

<a id="custom-openai-compatible-endpoints"></a>

## Custom Configured Providers (Anthropic, Gemini, Local Models)

To connect directly to Anthropic, Gemini, or a local server such as Ollama or llama.cpp, add an entry under `providers` in `settings.json` or use the `/providers` menu.

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
- **Loopback endpoints**: Local endpoints (`127.0.0.1`, `localhost`, `::1`) do not require API keys. Remote endpoints can specify an optional `apiKey`.


## Managing Providers Interactively (`/providers`)

Run `/providers` in any interactive session to open the Provider Manager:
- List active and available providers.
- Add new custom endpoints.
- Edit existing connection settings (Base URL, API keys).
- Switch active accounts when multiple OAuth accounts are configured.
- Remove custom providers.

## Built-in Providers

Use `-p` with one of these provider IDs.

| Provider | Identifier (`-p`) | Connection Method | Auth Mechanism | Notes |
| :--- | :--- | :--- | :--- | :--- |
| **OpenAI** | `openai` | WebSocket Responses / Chat Completions | `OPENAI_API_KEY` or `agent.openai.apiKey` | Default provider. Supports native server-side context management. |
| **ChatGPT / Codex** | `codex` | WebSocket Responses | PKCE OAuth (`term2 --codex-login`) | Direct login with ChatGPT subscription credentials. |
| **xAI Grok** | `grok` | Responses API | PKCE OAuth (`term2 --grok-login`) | Encrypted reasoning tokens round-tripped with full continuity. |
| **OpenRouter** | `openrouter` | HTTP Streaming | `OPENROUTER_API_KEY` or `agent.openrouter.apiKey` | Offers models from multiple vendors, including Claude, Gemini, DeepSeek, and Llama. |
