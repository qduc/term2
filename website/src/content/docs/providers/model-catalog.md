---
title: Model Catalog & Reasoning
description: Choosing models, listing available models, setting reasoning effort, and managing favorites.
---

## Specifying Models

You can select a model when starting term2 using the `-m` or `--model` flag:

```bash
# Model identifier
term2 -m gpt-5.1

# Provider and model combination
term2 -p openrouter -m anthropic/claude-3.7-sonnet

# Model with reasoning effort specified inline
term2 -m o3-mini:high
```

In an interactive session:
- Run `/model <model-name>` to switch models immediately.
- Press `Ctrl+O` or run bare `/model` to open the interactive Model Picker menu.

## Listing Available Models (`--list-models`)

term2 can query the live catalog of models available across all configured providers:

```bash
# List all available models
term2 --list-models

# Filter by a search term
term2 --list-models sonnet
term2 --list-models gpt-5

# Bypass disk cache and fetch fresh models from provider APIs
term2 --list-models --refresh
```

## Reasoning Effort (`-r`, `--reasoning`, `/effort`)

For models that support variable reasoning effort (such as OpenAI o1, o3, Grok, and thinking models), configure the reasoning level:

Supported levels: `default`, `none`, `minimal`, `low`, `medium`, `high`, `xhigh`.

```bash
# Set at launch
term2 -r high

# Set in an interactive session
/effort medium

# Or open the reasoning menu directly with keyboard shortcut
Ctrl+T
```

`default` indicates that term2 will not send an explicit reasoning parameter to the API, allowing the provider or model default to take effect.

## Favorites & Nicknames

In the interactive model picker (`Ctrl+O`):
- **Favorites (`Ctrl+F`)**: Mark frequently used models as favorites. Favorited models appear at the top of the picker and resolve instantly.
- **Nicknames (`Ctrl+N`)**: Assign a short name to a model (e.g. `sonnet` -> `openrouter/anthropic/claude-3.7-sonnet`). Passing the nickname to `-m` resolves immediately without waiting for catalog lookups.
