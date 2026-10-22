# Now hiring: additions to Bare

Bare (1.3.0: shell, editors, project instructions, skills, environment) is a
small, sharp team and wants a few more members. Additions earn a place by
making Bare cheaper or better on a real task without making it worse
elsewhere.

## The role

- Join Bare as exactly one context source, capability, or prompt fragment.
- Pull your weight: fewer tokens on a fair paired task, no quality regression.
- Play well with others: no new external services and no model change.

## Requirements

- Survive a one-pair screen against shipped Bare. Quality is checked first,
  then tokens.
- Back it up with three fresh confirmation pairs.
- Pass the executed-read gate: read before you overwrite.

## Already hired

- Skills: catalog plus `activate_skill` (1.2.0).
- Environment context (1.3.0).

## Previous applicants (thanks, but no)

| Applicant | Result |
| --- | --- |
| Read tools (`glob`, `grep`, `read_file`) | 74% more tokens |
| Session tools and context | 6% more; never used its tools |
| Clarification (`ask_user`) | 114% more tokens |
| External / MCP | Didn't show up: no runnable service |

## Where candidates come from

Token cost is roughly the number of calls times the context size, because
every call resends the conversation. Bare's minimal tool surface saves tokens
because shell batches work into fewer calls. Skills and environment save
tokens because they answer, up front, a question the model would otherwise
spend a call on: the receipt format, or where it is and what OS it's on.

So an addition earns its place when it removes more round trips than it adds
in per-call cost. Look for candidates in Bare's traces, not in the feature
list. Every call outside the essential read → edit → verify path is an
opening. Classify those calls by cause (discovery, failed command and retry,
re-read, verification retry), then hire the cheapest static text that
prevents the biggest cause. That text may not exist yet.

Wasted-call causes already seen:

- Escaping `!` in `node -e` under zsh. This happened in most arms, Bare and
  environment alike.
- `mktemp` failing on the sandbox temp dir, followed by a blocked-read
  approval detour.
- Checksum and permission errors inside the sandbox.

## The underlying gap: local knowledge

The model already knows coding in general. What it can never know is anything
local: the user, the machine, the harness, the project, and the repository's
current state. Each wasted call is the model buying, or guessing wrong about,
a local fact. That explains the scores so far:

- Hired: environment and skills both supply local facts.
- Rejected: read tools and sessions are capabilities, not knowledge.
- Clarification fetches local facts, but by asking the human, which is the
  most expensive round trip.

Local-knowledge gaps, ranked by expected value:

1. **User**: preferences and past corrections. This is **memory**.
2. **Harness**: sandbox temp dir, network proxy, approval model.
3. **Machine**: installed tools and shell quirks. State the consequence, not
   just the fact. Environment says `shell: zsh`, yet the model still broke
   `!` quoting; "zsh: put scripts in a heredoc" would have helped.
4. **Project commands**: package manager and build, test and lint commands.
   Running `npm` in a `pnpm` repo gives `EBADDEVENGINES`, one wasted call.
5. **Repository state**: branch, dirty files, worktrees.

Prediction: candidates that supply local facts, ideally already turned into
their consequences, win. Generic capabilities (`run_code`, subagents, web,
background tasks, code-context) lose unless the task requires them.

## Open applications

### Prompt fragments

Bare currently skips every one of these (`prompt-constructor.ts:67`).

- **Shell sandbox addendum** (`shell-sandbox.ts`). This is the top pick. It
  covers the sandbox temp dir, the `sandbox="unsandboxed"` retry and the
  network proxy. Its absence plausibly caused next-candidate confirmation
  pair 3's `mktemp` failure and its blocked-read detour.
- **Approval model** (`approval-model.md`, ~200 words). It says "attempt the
  action; the layer decides". It could cut asking in prose and stalling.
- **Worktree hygiene** (`worktree-hygiene.md`, ~180 words). It covers dirty
  state and validation safeguards.
- **Search-via-shell addendum** (`search-via-shell.ts`). It covers efficient
  `rg`/`fd` use, since Bare already searches through shell.
- **Direct-editor tools addendum** (`tool-surface-guidance.ts`). It covers
  editor usage. Bare's 3.7k-character prompt may under-explain
  `search_replace`.
- **Skill instruction conflicts** (`fragments/skill-instruction-conflicts.md`).
  It's relevant now that skills were hired.
- **Background shell addendum** (`background-shell.ts`). Pair it with the
  background-tasks capability.

### Capabilities

- **Memory**: context plus tools.
- **Code-context.**
- **Background tasks**: background shell, monitor, cancel.
- **`run_code`/JS workflows.** Bare explicitly disables these.
- **Worktree tools**: enter and exit.
- **Subagents.** The likely cost is high; screen only with a delegation task.
- **Web.** This depends on network allowlisting; check that it's runnable
  first.

## Screening order (suggested)

1. Shell sandbox addendum.
2. Approval model.
3. Search-via-shell addendum.
4. `run_code`.

Then background tasks, memory and code-context. Prompt fragments are cheap
to try (a few hundred tokens each), so they go first.
