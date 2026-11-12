Migrate Term2's built-in OpenRouter provider from @openrouter/ai-sdk-provider to
the existing application-owned OpenAI Chat Completions adapter. Work only in
this isolated repository snapshot; implement and validate locally, then report
the changes and remaining limitations. Independent acceptance review is handled
externally. Do not commit, push, publish, merge, fetch upstream history, or look
for a historical solution. Do not make live provider calls.

Requirements:

- Reuse the owned chat-completions adapter; remove the obsolete SDK provider
  implementation and dependency, keeping the pnpm lockfile consistent. Preserve
  every other dependency and existing provider's behavior.
- Preserve OpenRouter API key/base URL settings and referrer/title HTTP headers.
  Preserve the existing preprocessing, Anthropic cache annotations and signed
  reasoning filtering.
- Translate selected reasoning effort to OpenRouter's reasoning:{effort}, not
  reasoning_effort. Explicit reasoning overrides the selected effort. Provider
  options may be top-level, under openrouter, or providerOptions.openrouter:
  flatten them, later namespaced values win, except top-level reasoning wins.
  Do not emit the option-wrapper keys on the wire.
- Preserve streamed text, reasoning and reasoning_details, usage/cost metadata,
  tool calls and continuation replay. An upstream provider reported by OpenRouter
  belongs in completion metadata; other chat-completions providers must not start
  treating it that way. Preserve legacy reasoning as text after provider switches.
- Send tool_choice only when tools exist. Retain useful upstream error detail
  from error.metadata.provider_name and raw (string or JSON object), skipping
  null raw values. Preserve normal retry ownership and cancellation behavior.
- With no traffic recorder, an in-band error must settle without waiting forever
  on an unread response clone. With an active recorder and a closed error stream,
  retain its error frame. Do not detach response cancellation in a way that loses
  recorded errors. Solving a held-open error stream WITH an active recorder is
  explicitly outside this task; do not claim that gap is fixed.
- Keep module documentation and existing architecture/complexity guards valid.
  Add or update meaningful integration coverage as appropriate; do not weaken
  guards or replace real-boundary tests with mocks. For any regenerated wire
  fixtures preserve response frames and document request-frame provenance.

Follow AGENTS.md and relevant repository skills. Run local checks appropriate to
a provider migration, including TypeScript checking and provider boundary tests.
The harness supplies installed baseline dependencies. The two runners receive
the identical snapshot and instructions. Benchmark routing variables are present
only to meter this coding agent: when launching provider fixture tests, unset
OPENAI_BASE_URL, AGENT_TRANSPORT and AGENT_MAX_OUTPUT_TOKENS for that subprocess;
those tests must use their own loopback endpoints. Never change product code to
route task validation through the benchmark gateway.
