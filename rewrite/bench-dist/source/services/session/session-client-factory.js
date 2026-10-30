import { ToolOwnershipRegistry } from '../approval/tool-ownership-registry.js';
import { PostExecutePendingRegistry } from './post-execute-pending-registry.js';
import { PostExecutePauseCapability } from './post-execute-pause-capability.js';
import { SessionAccessState } from './session-access-state.js';
import { ProviderContinuity } from '../provider-continuity.js';
import { OpenAICandidateObserver } from '../openai-candidate-observer.js';
import { DefaultOpenAIRootCheckpointLifecycleObserver, } from '../openai-root-checkpoint-lifecycle-observer.js';
import { OpenAIRootProviderIdentity } from '../openai-root-provider-identity.js';
import { HookEventFactory } from '../hooks/hook-event-factory.js';
import { createToolExecutionLifecyclePort } from '../hooks/hook-tool-lifecycle.js';
import { BackgroundShellRegistry } from '../shell/background-shell-registry.js';
import { BackgroundShellOutputStore } from '../shell/background-shell-output-store.js';
import { BackgroundShellWatches, } from '../shell/background-shell-watches.js';
import { SessionIdentity } from './session-identity.js';
/**
 * Production timer adapter for {@link BackgroundShellWatches}: a real
 * `setTimeout`/`clearTimeout` pair. The watches module keeps its scheduler
 * injected so unit tests drive time deterministically; owned sessions pass
 * this adapter when the watch layer is created.
 */
function createBackgroundShellWatchScheduler() {
    return {
        schedule: (callback, delayMs) => setTimeout(callback, delayMs),
        cancel: (handle) => clearTimeout(handle),
    };
}
/**
 * Makes a factory for production clients. Each handle owns exactly the client
 * it creates, so replacement sessions cannot retain a prior closure-bound
 * client or its subscriptions.
 */
export function createOwnedSessionClientFactory(settings, createClient, hookLifecycle, defaults) {
    return {
        create(sessionId, options) {
            const sessionIdentity = new SessionIdentity(sessionId, options?.sessionStartedAt);
            const continuationProjectionMode = settings.get('agent.modelSelection').provider === 'openai' ? 'openai-provider' : 'legacy';
            const toolOwnership = new ToolOwnershipRegistry();
            const access = new SessionAccessState(settings, { allowEdit: defaults?.allowEdit });
            const postExecutePending = new PostExecutePendingRegistry({
                sessionId: sessionIdentity,
                epoch: crypto.randomUUID(),
            });
            const postExecutePauseCapability = new PostExecutePauseCapability(postExecutePending);
            const providerContinuity = new ProviderContinuity();
            const openAIRootCheckpointLifecycleObserver = continuationProjectionMode === 'openai-provider'
                ? new DefaultOpenAIRootCheckpointLifecycleObserver()
                : undefined;
            const openAIRootProviderIdentity = new OpenAIRootProviderIdentity();
            const requestCapture = new OpenAICandidateObserver(providerContinuity, openAIRootCheckpointLifecycleObserver, openAIRootProviderIdentity);
            const hookEvents = hookLifecycle
                ? new HookEventFactory({
                    sessionId: sessionIdentity,
                    includeUserText: settings.getDynamic('hooks.includeUserText') === true,
                    includeToolArguments: settings.getDynamic('hooks.includeToolArguments') === true,
                    includeToolResults: settings.getDynamic('hooks.includeToolResults') === true,
                })
                : undefined;
            const toolLifecycle = hookLifecycle && hookEvents ? createToolExecutionLifecyclePort(hookLifecycle, hookEvents) : undefined;
            const allowBackgroundShell = options?.allowBackgroundShell ?? defaults?.allowBackgroundShell ?? true;
            const allowAskUser = options?.allowAskUser ?? defaults?.allowAskUser ?? true;
            const backgroundShellRegistry = allowBackgroundShell
                ? new BackgroundShellRegistry()
                : undefined;
            // The output store + watch layer are session-owned beside the registry:
            // the shell tool opens a job's stream at launch and the monitor tools
            // register watches against the same watch set.
            const backgroundShellOutput = allowBackgroundShell
                ? (() => {
                    const store = new BackgroundShellOutputStore();
                    return {
                        store,
                        watches: new BackgroundShellWatches({ store, scheduler: createBackgroundShellWatchScheduler() }),
                    };
                })()
                : undefined;
            const agentClient = createClient(sessionId, toolOwnership, postExecutePauseCapability, access, continuationProjectionMode, providerContinuity, requestCapture, toolLifecycle, backgroundShellRegistry, allowBackgroundShell, backgroundShellOutput, allowAskUser);
            let disposed = false;
            return {
                agentClient,
                sessionIdentity,
                providerContinuity,
                openAIRootCheckpointLifecycleObserver,
                continuationProjectionMode,
                toolOwnership,
                access,
                postExecutePending,
                postExecutePauseCapability,
                hookLifecycle,
                hookEvents,
                toolLifecycle,
                backgroundShellRegistry,
                backgroundShellOutput,
                dispose() {
                    if (disposed)
                        return;
                    disposed = true;
                    agentClient.dispose?.();
                    void backgroundShellRegistry?.dispose();
                    postExecutePauseCapability.setActiveRunId(null);
                    postExecutePending.close();
                    toolOwnership.clear();
                    access.dispose();
                },
            };
        },
    };
}
/**
 * Compatibility seam for callers that provide a prebuilt client. Its owner
 * remains responsible for disposal, including across ConversationService reset.
 */
export function createCallerOwnedSessionClientFactory(agentClient, toolOwnership) {
    return {
        create(sessionId = 'caller-owned', options) {
            const sessionIdentity = new SessionIdentity(sessionId, options?.sessionStartedAt);
            const providerContinuity = new ProviderContinuity();
            const postExecutePending = new PostExecutePendingRegistry({
                sessionId: sessionIdentity,
                epoch: crypto.randomUUID(),
            });
            return {
                agentClient,
                sessionIdentity,
                providerContinuity,
                continuationProjectionMode: 'legacy',
                toolOwnership,
                postExecutePending,
                postExecutePauseCapability: new PostExecutePauseCapability(postExecutePending),
                dispose: () => { },
            };
        },
    };
}
//# sourceMappingURL=session-client-factory.js.map