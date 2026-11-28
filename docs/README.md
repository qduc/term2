# Term2 repository documentation

For installation and everyday use, start with the [project README](../README.md)
or the [documentation site source](../website/src/content/docs/).

| If you want to… | Start here |
| --- | --- |
| Trace a request through the application | [Architecture overview](architecture/architecture-overview.md) and [layer boundaries](architecture/layers.md) |
| Change behavior another client or subsystem relies on | [System contracts](contracts/README.md) |
| Run TUI, headless, ACP, or web sessions on the local daemon | [Local daemon](reference/local-daemon.md) |
| Check which surfaces and persisted formats are supported | [Support tiers](reference/support-tiers.md) |
| Debug tools, clients, or provider traffic | [Logging](reference/logging.md), [shell sandbox](reference/shell-sandbox.md), and [Discord bridge](reference/discord-bridge.md) |
| Extend Term2 or its shared runtime | [Profiles](profiles/README.md), [public hooks](reference/public-hooks.md), [core releases](reference/release-agent-core.md), and [wire releases](reference/release-agent-wire.md) |
| Understand how the repository verifies behavior | [Evidence-driven development](experiments/evidence-driven-development/README.md) and [generated verification](experiments/generated-verification/README.md) |
| Find the intent behind a feature or past decision | [Plans](plans/README.md), [research](research/), and [lessons](lessons/) |

Use the linked code and contracts to check current behavior. Plans capture intent,
research records findings under the conditions described there, and lessons
preserve explanations from past work.
