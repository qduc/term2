# @qduc/agent-core

Headless session runtime and provider registries shared by Term2 and ChatForge.
Requires Node.js 20 or later. This is an ESM-only package with TypeScript declarations.

```ts
import {
  createProviderRegistry,
  createWebSearchRegistry,
  createSessionAccountStore,
} from '@qduc/agent-core';

const providers = createProviderRegistry();
const searches = createWebSearchRegistry();
const accounts = createSessionAccountStore();
```

Create separate registries and account stores for each user or runtime rather
than sharing mutable state across tenants.

The package also exports `createSessionRuntime` and its session port types.
Session construction requires application-supplied services and an agent client;
this package is not a turnkey chatbot, CLI, gateway server, or tool sandbox.
See the exported `CreateConversationSessionOptions` type for the composition contract.

The implementation is compiled from Term2's source tree during the package
build. Prompt assets are included in the tarball. The `0.1.x` API is preliminary;
source ownership has not yet moved into an independent repository.

Release preparation and publication instructions are in
[`docs/release-agent-core.md`](https://github.com/qduc/term2/blob/main/docs/release-agent-core.md).
