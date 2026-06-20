# term2 Domain Context

This context defines the ubiquitous language for the term2 terminal-based AI assistant CLI.

## Language

**Agent**:
The autonomous entity responsible for reasoning, invoking tools, and coordinating conversation turns.
_Avoid_: Bot, assistant

**Turn**:
A single execution lifecycle starting with a user's input, containing one or more model loops, and ending with a final response.
_Avoid_: Request, step, loop

**Session**:
The persistent boundary containing a conversation's history, active settings, and turn coordination state.
_Avoid_: Chat, connection

**Tool**:
A discrete utility or capability exposed to and invoked by the agent to perform actions on the system or files.
_Avoid_: Function, API, shell command

**Subagent**:
A specialized, secondary agent spawned to perform tasks (like research or coding) in the background.
_Avoid_: Child agent, helper

**Approval Policy**:
The set of safety rules determining whether a tool execution requires explicit user confirmation.
_Avoid_: Security configuration, safety rules

**Provider**:
An adapter normalising communication with a specific external language model API.
_Avoid_: Model, LLM, client

**Slash Command**:
A presentational shortcut triggered directly by the user via the input line prefix.
_Avoid_: Keyboard shortcut, terminal command
