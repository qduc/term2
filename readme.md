# term2

A terminal-based AI assistant that can help you get things done on your computer.

## What is this?

term2 is a chat interface in your terminal where you can talk to an AI assistant. The assistant can execute bash commands to help you with tasks like managing files, running scripts, checking system info, and more. Before running any command, it asks for your permission, so you're always in control.

## Installation

You'll need Node.js installed on your computer. Then run:

```bash
npm install --global term2
```

You'll also need an OpenAI API key. Set it as an environment variable:

```bash
export OPENAI_API_KEY="your-api-key-here"
```

Add this to your `~/.bashrc` or `~/.zshrc` to make it permanent.

## How to use

Just run:

```bash
term2
```

You'll see a chat interface. Type your message and press Enter. The AI will respond and may suggest bash commands to help you. If a command needs to run, you'll be asked to approve it with `y` (yes) or `n` (no).

Examples of what you can ask:

-   "What files are in my current directory?"
-   "Show me my git status"
-   "Create a backup of my documents folder"
-   "What's using port 3000?"

## Options

```bash
term2 -m gpt-4o      # Use a different OpenAI model
term2 --model gpt-4o # Same as above
```

The default model is gpt-4.1.

## Tips

-   The assistant won't run dangerous commands without your approval
-   You can reject any command by pressing 'n' when prompted
-   Press Ctrl+C to exit the chat at any time
