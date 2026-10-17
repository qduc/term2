# Conversation actor — one-page architecture

```mermaid
flowchart LR
    Human["User / control client"] -->|"submit, edit, retract, steer\napprove, retry, reconcile\ncancel targeted turn, rollover"| Mail
    subgraph Actor["Conversation — one mutable-state owner"]
      Mail["FIFO mailbox\nreentrant sends queue"] --> Transition["Synchronous transition"]
      Transition <--> State["Submission map + canonical history\nactive turn + operation serial\nbackground registry + session ID"]
      Transition --> Workflow["Stored turn continuation\nphase + calls + next index"]
      Workflow --> Fence["Completion admitted only for\nmatching phase + operation token"]
      Fence --> Transition
      Transition --> Journal["Ordered execution events"]
    end
    Workflow -->|"request snapshot + abort signal"| Model["Fake model port"]
    Workflow -->|"call copy + execution ID + abort signal"| Tool["Fake tool port"]
    Model -->|"reply / failure message"| Mail
    Tool -->|"foreground completion message"| Mail
    Tool -->|"background completion message\nrequires registry membership"| Mail
    Journal -->|"isolated copies"| Observers["Independent observers"]
```

```mermaid
stateDiagram-v2
    [*] --> model: consume queued submission
    model --> approval: reply contains approval-gated call
    model --> tool: reply contains ordinary call
    model --> retry: typed retryable failure, drop anchor
    retry --> model: matching retry command, drain steers
    approval --> tool: matching allow
    approval --> model: denied last call, record result
    tool --> unknown: ambiguous outcome, drop anchor
    unknown --> model: reconciled last call, record result
    tool --> model: last result, drain steers
    model --> [*]: final reply, settle consumed submissions
```

For a multi-call response, a settled/denied/reconciled call advances to the next
call (and approval if required); the diagram abbreviates those edges. Launching
a background call registers independent work and records its handle as the call
result; the workflow continues immediately. Job completion appends a notification
even while idle, without opening an unsolicited model turn.

Cancel from any active phase revokes the turn before cooperative abort, repairs
unfinished call/result pairs, settles consumed submissions, and returns unconsumed
steers. Rollover additionally resets history/anchor and session-scoped jobs;
conversation-scoped jobs keep the same execution and report to the successor.
Each await lives in a port; the actor's continuation is explicit data, not a
second asynchronous controller. Cancellation cannot prove physical tool exit.
