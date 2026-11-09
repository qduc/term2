---
title: First Run
description: Connect a provider and send your first prompt.
---

[Install term2](/term2/getting-started/installation/), then sign in or set an API key.

## 1. Connect a provider

### ChatGPT / Codex login

```bash
term2 --codex-login
```

Sign in with an eligible ChatGPT account. This saves your credentials. Choose a Codex model in the next step.

### OpenAI API key

Set your own key in the shell where you will launch term2:

```bash
export OPENAI_API_KEY="your-api-key"
```

For OpenRouter, use `OPENROUTER_API_KEY`; for Grok, use `term2 --grok-login`. Direct Anthropic, Gemini, and local endpoints first need a custom provider entry through `/providers` or settings. Setting their environment variables alone does not register the provider. See [provider setup](/term2/providers/) and [authentication](/term2/providers/authentication/).

## 2. Open a project and choose a model

```bash
cd /path/to/your/project
term2 --model
```

Select a model **from the provider you authenticated**. Bare `--model` opens the picker in an interactive terminal with no prompt on the command line. It does not open a picker in a pipe or a non-interactive invocation.

During a session, `/model` or `Ctrl+O` opens model selection; `/providers` manages connections and accounts. If the catalog or login fails, see [troubleshooting](/term2/troubleshooting/).

## 3. Explore before editing

> Explain how this project starts. Point me to the entry points and the command for running its tests.

Open the files the assistant cites and check the test command against the project’s own instructions.

## 4. Make one small change

Ask for a change and specify how to test it.

> Add a test for this edge case, fix the failure, and run that test. Explain the resulting diff.

By default, term2 asks before running a shell command in an interactive session. Edits within the local workspace can apply without a prompt. Review the diff and test output. See [approvals](/term2/safety/approvals/) and [shell sandboxing](/term2/safety/sandbox/) for the rules.

## 5. Pick up later

Use `/quit` to leave the session. From the same project, run:

```bash
term2 --resume
```

To list saved sessions or branch an existing conversation:

```bash
term2 --resume ls
term2 --resume <session-id> --fork
```

A fork creates a separate conversation; it does not create a git branch or restore file changes. See [sessions and resumption](/term2/using-term2/sessions/).
