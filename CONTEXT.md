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
A single execution lifecycle starting with a user's input, spanning one or more Segments, and ending with a final response.
_Avoid_: Request, step, loop

**Segment**:
One unbroken span of Run Loop execution inside a Turn. A Turn pauses at each approval and resumes as a new Segment, so a Turn the user sees as continuous is many Segments.
_Avoid_: Run, pass, iteration

**Turn Attempt**:
One try at producing a Turn, restarted by retry or recovery. Distinct from a Segment, which is a planned pause and resume rather than a restart.
_Avoid_: Retry, run

**Request Boundary**:
The point inside a Segment after the current round's tool results are recorded and before the next model request is built. The only place a message may enter a Turn already in flight.
_Avoid_: Checkpoint, safe point, gap

**Continuation**:
An opaque capability for resuming a Turn that paused at the end of a Segment, typically to await an approval decision.
_Avoid_: Resume token, run state

**Session**:
The persistent boundary containing a conversation's history, active settings, and turn coordination state.
_Avoid_: Chat, connection

**Transcript**:
The ordered, provider-facing record of a conversation that is replayed to the model on each turn.
_Avoid_: History, log, messages

**Injection**:
Delivering a message into a Turn already in flight, admitted at a Request Boundary so the model reads it in sequence. Nothing is cancelled and no running Tool is disturbed. Its lifetime is the Turn: it survives the Segment boundaries the Turn pauses at.
_Avoid_: Interrupt, mid-turn send, push

**Steering**:
Injection of user input — the user speaking to a Turn that is already running rather than opening a new one.
_Avoid_: Interrupt, follow-up

**Queue**:
The ordered set of user inputs awaiting execution, with its own pause and resume state, persisted so an interrupted Turn can be recovered.
_Avoid_: Backlog, buffer

### Delegation

**Subagent**:
A specialized, secondary agent spawned to perform tasks (like research or coding) in the background.
_Avoid_: Child agent, helper

**Role**:
The named capability profile a subagent is spawned under (explorer, worker, mentor, librarian), fixing its tools and whether it may write.
_Avoid_: Persona, type, agent kind

**Background Notification**:
The report of a settled asynchronous subagent run, returned to the agent that launched it. Reaching the launching agent is an Injection like any other.
_Avoid_: Callback, completion event, result message

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
