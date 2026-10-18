# Assemble an agent: two executable prototypes

These are standalone composition experiments. They do not change Term2's production
runtime. Both run the same loop and feature pieces; only assembly differs.

| Candidate | Assembly mechanism | What this slice reveals |
| --- | --- | --- |
| A: Awilix + Tapable | Resolve piece factories through an agent-scoped DI container | Dependencies resolve independently of piece installation order; more application lifecycle remains ours |
| B: Fastify + Tapable | Boot an encapsulated plugin tree with named dependencies and decorators | Framework owns boot/close and scope isolation, but prerequisites must be registered first |

Tapable supplies ordered waterfall hooks in both. A tool hook can rewrite an
invocation, wait for approval, deny it, or supply a result without dispatch.
Memory exposes its own beforeSave hook; a separate redaction piece extends it.

## Try it

From the repository root:

```sh
cd experiments/agent-assembly-prototypes
pnpm install --frozen-lockfile
pnpm demo
```

The demo runs both candidates across approval, denial, cancellation, hook reordering,
missing dependency, dependency installation order, and different agent assemblies.
It prints the artifact directory containing JSON lifecycle traces and real memory files.
It prints observations rather than asserting that a candidate passes every requirement.

Inspect one lifecycle:

```sh
pnpm demo --backend awilix --scenario approved --trace
```

Edit `assemblies.json`, then try the configuration with actual terminal approval:

```sh
pnpm demo --backend awilix --scenario custom --config assemblies.json --interactive
```

Useful edits:

- Move cache before rewrite in `hookOrder.tool.execute`: `cached:HELLO` becomes
  `executed:HELLO`, because the original arguments miss the seeded cache.
- Change main's storage binding from `disk` to `alternate`: memory moves to a
  different storage instance without changing the memory piece.
- Remove approval from both `pieces` and its hook order: the interaction disappears.
- Remove redaction from both places: the memory file retains the original input.
- Remove memory but leave redaction: assembly fails before model execution.
- Give explorer a memory piece, storage binding and request hook entry: it gains
  independent memory while using the same storage service as main.

Approval before cache asks even on cache hits. Cache before approval can supply a
result before approval sees a pending invocation. Order is deliberately consequential;
these are trusted pieces, not an authorization boundary for untrusted plugins.

## Read the implementation

- `loop.ts`: the fixed model–tool loop and lifecycle emission; no feature names.
- `pieces.ts`: feature implementations and their dependency/hook declarations.
- `assemblies.ts`: the two composition adapters and default blueprint helper.
- `contracts.ts`: core types, Tapable hooks, and generic configuration checks.
- `demo.ts`: the frontend, scripted interaction responses and scenario driver.
- `spec.md`: human decisions, acceptance criteria and scope limits.
- `evidence/`: retained CLI observations and independent verification.

To add a piece, implement `Piece`, declare its factory/dependencies/hooks in a catalog,
and select it in a blueprint. Both host constructors accept a replacement catalog;
the loop and generic validation do not need a new feature branch. The default
catalog is statically imported; package discovery is outside this experiment.

## Findings and limits

In the recorded CLI runs, both candidates demonstrate configured hook ordering,
argument rewriting, approval denial, cancellation during approval, cached result
replacement, memory redaction, and agent scope separation with shared storage.

The reversed dependency scenario succeeds with A and fails during B's boot.
That is a limitation against automatic dependency assembly. This Fastify adapter
also freezes agent creation after boot and disposes its plugin tree together;
A permits creating scopes later and disposing them separately. We have not added
a sorting layer or a dynamic child-host mechanism to make B imitate A.

My preliminary preference is A for this requirement set. B is useful evidence of
what a framework-owned lifecycle buys and what constraints it introduces.
Human assessment of the assembly experience remains pending.

Neither candidate establishes production readiness. The provider is deterministic,
the echo tool has no external effects, and the store supports sequential demo
runs. Streaming, retries, compaction, physical job cancellation, crash durability,
production Term2 integration, and untrusted plugin isolation remain unverified.
The loop is deliberately shared, so this compares composition rather than two
competing execution engines. App/session hooks, configurable model/tool providers
and plugin resource disposal are not implemented as extension surfaces here.

Existing mechanisms used: [Awilix](https://github.com/jeffijoe/awilix),
[Tapable](https://github.com/webpack/tapable),
[Fastify plugins](https://fastify.dev/docs/latest/Reference/Plugins/), and
[fastify-plugin](https://github.com/fastify/fastify-plugin).
