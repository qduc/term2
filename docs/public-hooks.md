# Public hooks

Term2 can load small, executable TypeScript or JavaScript hook modules from the
local machine. Hooks are an observational lifecycle surface, not a plugin API:
they cannot register tools, change arguments, replace results, or decide
approvals.

## Installation

User hooks live in `~/.term2/hooks/`. Project hooks live in
`<session cwd>/.term2/hooks/` and are disabled by default. Enable project hooks
with `hooks.project.enabled` and add the canonical project root to
`hooks.trustedProjectRoots` (for example, through `/settings`). A project hook
never runs merely because its file is present. User hooks are implicitly
trusted; disable them in CI or shared-home environments with
`hooks.user.enabled=false`.

Files are loaded once at startup in lexical order. User files run before project
files. Only `.js`, `.mjs`, and `.ts` files are considered; symlinked files and
directories are rejected. A broken module is reported and skipped without
preventing Term2 from starting. Hook code runs in the Term2 process with the
same operating-system permissions as Term2 and is not protected by tool
approval or the shell sandbox.

## Authoring a hook

Each file default-exports a registration function. The public declaration
surface is available from `@qduc/term2/hooks`:

```ts
import type { Term2Hooks } from '@qduc/term2/hooks';

export default function register(term2: Term2Hooks): void {
  term2.on('status.change', event => {
    process.stderr.write(`${event.current}\n`);
  });
}
```

`on()` returns an unsubscribe function, but registration is only valid while
the default export is running. Callbacks are awaited in registration order.
Each callback has a five-second default timeout, and a callback failure or
timeout is logged and fails open. A timed-out in-process callback cannot be
forcibly cancelled. Hook activity does not recursively create Term2 tool
events.

## Event contract

Version 1 exposes these semantic events:

`session.start`, `session.end`, `status.change`, `turn.start`, `turn.end`,
`turn.error`, `tool.before`, `tool.after`, `tool.error`,
`approval.requested`, and `approval.resolved`.

Every event has `schemaVersion: 1`, an opaque `eventId`, the root `sessionId`,
the local timestamp, and a `scope` of `root` or `{ subagent: { agentId,
role } }`. A logical `turnId` survives provider retries and approval
continuations. `toolCallId` correlates physical tool and approval activity.
Unknown tools do not produce tool lifecycle events because no physical tool was
invoked. Auto-approval produces a resolution without a preceding request.

The public status is deliberately coarse: `streaming` and `continuing` map to
`working`; an `ask_user` interaction maps to `waiting_for_user`; ordinary tool
approval maps to `waiting_for_approval`; failures return to `idle` after a
`turn.error`. Reset, undo, and provider/model changes do not end the session.

User text, full tool arguments, and full tool results are summarized or omitted
by default. Opt into each content class separately with
`hooks.includeUserText`, `hooks.includeToolArguments`, and
`hooks.includeToolResults`.

## Herdr status example

`docs/herdr-status-hook.ts` shows the intended first-party consumer
shape. It translates the public `status.change` event to a local Herdr command;
no Herdr-specific behavior is built into Term2. Adjust the final command to
the Herdr installation and pane-selection mechanism used on the host.

Hook events describe the local Term2 process and local session cwd. They are
not discovered or executed on an SSH target even when tools execute remotely.

## File-write protection

Term2 file tools require explicit approval before creating, updating, or
otherwise writing a file under either hook directory. This remains true for a
trusted project and for paths physically inside the active workspace. Trust
permits loading code; it never permits silent model writes to executable hook
code.
