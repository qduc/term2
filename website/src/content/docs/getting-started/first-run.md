---
title: First Run
description: Connect a provider, pick a model, and explore a project before making a change.
---

[Install term2](/term2/getting-started/installation/) first. For your first session, use a project you can inspect and choose one of these authentication paths.

## 1. Connect a provider

### ChatGPT / Codex login

```bash
term2 --codex-login
```

Complete the browser login with an account that has access to the provider. Login stores credentials; it does not select Codex as the active provider. You will choose a Codex model in the next step.

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

Enter this slash command in the chat:

```text
/plan
```

Then ask:

> Explain how this project starts. Point me to the entry points and the command for running its tests.

Plan mode blocks workspace mutations. Review the files and commands the agent uses, then compare its answer with the project itself. A useful first result names the actual entry points and test command, rather than guessing a generic setup.

## 4. Make one small change

Enter `/plan` again to return to Standard mode. Describe a narrow change and how to check it, for example:

> Add a test for this edge case, fix the failure, and run that test. Explain the resulting diff.

Default interactive settings prompt for shell commands. Valid local workspace edits can apply without a prompt; file operations outside that boundary or needing additional authorization can ask for approval. Review approval requests, the resulting diff, and check output. Keep the defaults for your first session; see [approvals](/term2/safety/approvals/) and [shell sandboxing](/term2/safety/sandbox/) before changing them.

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
