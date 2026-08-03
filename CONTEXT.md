# term2 Domain Context

This context defines the ubiquitous language for the term2 terminal-based AI assistant CLI.

## Language

### Agents and execution

**Agent**:
The autonomous entity responsible for reasoning, invoking tools, and coordinating conversation turns.
_Avoid_: Bot, assistant

**Run Loop**:
The application-owned loop that drives an agent: send input to a provider, consume the streamed turn, execute tools, repeat until the agent stops.
_Avoid_: SDK loop, executor loop

**Turn**:
A single execution lifecycle starting with a user's input, containing one or more model loops, and ending with a final response.
_Avoid_: Request, step, loop

**Turn Attempt**:
One try at producing a Turn. A Turn may span several attempts when a retry or recovery restarts the model stream.
_Avoid_: Retry, run

**Continuation**:
An opaque capability for resuming a model run that paused mid-turn, typically to await an approval decision.
_Avoid_: Resume token, run state

**Session**:
The persistent boundary containing a conversation's history, active settings, and turn coordination state.
_Avoid_: Chat, connection

**Transcript**:
The ordered, provider-facing record of a conversation that is replayed to the model on each turn.
_Avoid_: History, log, messages

**Steering**:
Additional user input accepted while a turn is already in flight, folded into the running agent rather than starting a new turn.
_Avoid_: Interrupt, follow-up

**Queue**:
The ordered set of user inputs awaiting execution, with its own pause and resume state, persisted so an interrupted run can be recovered.
_Avoid_: Backlog, buffer

### Delegation

**Subagent**:
A specialized, secondary agent spawned to perform tasks (like research or coding) in the background.
_Avoid_: Child agent, helper

**Role**:
The named capability profile a subagent is spawned under (explorer, researcher, worker, mentor, librarian), fixing its tools and whether it may write.
_Avoid_: Persona, type, agent kind

**Workflow**:
A sandboxed script that orchestrates one or more agent runs programmatically, without a human in the loop.
_Avoid_: Pipeline, automation, chain

### Capabilities

**Tool**:
A discrete utility or capability exposed to and invoked by the agent to perform actions on the system or files.
_Avoid_: Function, API, shell command

**Skill**:
A packaged set of instructions, discovered from the project or the user's home, that the agent activates to load task-specific guidance.
_Avoid_: Playbook, prompt template

**Memory**:
Durable notes the agent stores and recalls across sessions, distinct from the transcript of any one conversation.
_Avoid_: Notes, cache, knowledge base

### Safety

**Approval Policy**:
The set of safety rules determining whether a tool execution requires explicit user confirmation.
_Avoid_: Security configuration, safety rules

**Auto-approval**:
A rule that resolves an approval without prompting, because the requested action is known to be safe.
_Avoid_: Whitelist, allowlist, trust

**Sandbox**:
The restricted execution environment for shell commands, bounding which paths may be written and which operations may run.
_Avoid_: Jail, container

**Mode**:
A runtime posture that changes what the agent is permitted to do — most notably Plan Mode, which makes the workspace read-only.
_Avoid_: State, flag, setting

### Model access

**Provider**:
An adapter normalising communication with a specific external language model API.
_Avoid_: Model, LLM, client

**Recovery**:
The policy-driven handling of a failed or truncated model turn, deciding whether to retry, repair the transcript, or surface the failure.
_Avoid_: Retry logic, error handling

### Interface

**Slash Command**:
A presentational shortcut triggered directly by the user via the input line prefix.
_Avoid_: Keyboard shortcut, terminal command

**Rewind**:
Removing a past turn from the transcript so it can be edited or resent, returning the conversation to the state before it.
_Avoid_: Undo, revert

**Handoff**:
Capturing the current conversation's outcome as text intended to seed a fresh session or another agent.
_Avoid_: Export, summary

**Non-interactive Mode**:
Running the same conversation system to completion without the terminal UI, for scripted or piped use.
_Avoid_: Headless, batch, CI mode
