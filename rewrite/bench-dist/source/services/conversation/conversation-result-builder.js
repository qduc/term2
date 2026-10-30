import { ModelBehaviorError } from '../../contracts/model-errors.js';
import { CHECK_IN_TOOL_NAME } from '../../contracts/conversation.js';
import { extractUsage } from '../../utils/ai/token-usage.js';
import { extractCommandMessages } from '../../utils/streaming/extract-command-messages.js';
import { attachCachedArguments } from '../command-message-streaming.js';
import { createInvalidToolCallDiagnostic } from '../logging/logging-contract.js';
import { asRecord, getCallIdFromObject, getString, getToolInfoFromInterruption } from '../interruption-info.js';
import { selectAgentStreamItems } from '../agent-stream.js';
import { createContinuationHandle } from '../../contracts/continuation-handle.js';
import { shouldBypassToolApproval, isAutoApprovableTool, extractToolTargetPaths, } from '../approval/shell-auto-approval-resolver.js';
import { supportsFolderSessionRead } from '../../contracts/conversation.js';
import { resolveSessionReadFolder } from '../approval/session-read-grant-target.js';
import { parseToolCallArguments } from '../tool-call-arguments.js';
import { buildPersistedAssistantTurnItems } from './conversation-turn-items.js';
import { isRunBudgetInteraction } from '../agent-runtime/run-budget.js';
import { isDockerHostControlShellApproval, isUnsandboxedShell, requiresHumanShellApproval, } from '../approval/shell-sandbox-approval.js';
import { resolveOutsideWorkspaceEdit } from '../approval/approval-descriptor.js';
export function createApprovalRequiredTerminal(options) {
    return {
        type: 'approval_required',
        approval: {
            agentName: options.agentName,
            toolName: options.toolName,
            argumentsText: options.argumentsText,
            rawInterruption: options.rawInterruption,
            ...(options.callId ? { callId: options.callId } : {}),
            ...(options.llmAdvisory ? { llmAdvisory: options.llmAdvisory } : {}),
            ...(options.deniedRead ? { deniedRead: options.deniedRead } : {}),
            ...(options.dockerHostControl ? { dockerHostControl: true } : {}),
            ...(options.outsideWorkspaceEdit ? { outsideWorkspaceEdit: options.outsideWorkspaceEdit } : {}),
            ...(options.postExecute ? { postExecute: options.postExecute } : {}),
            ...(options.runBudgetEvent ? { runBudgetEvent: options.runBudgetEvent } : {}),
            ...(options.checkIn ? { checkIn: options.checkIn } : {}),
        },
        ...(options.usage ? { usage: options.usage } : {}),
        ...(options.costRecords && options.costRecords.length > 0 ? { costRecords: options.costRecords } : {}),
    };
}
const resolveFinalText = (streamedText, completedText) => {
    // Whitespace-only model output is empty. Action-only or notification-only
    // completions must not fabricate a terminal: downstream consumers already
    // suppress empty text, so an action-only turn settles silently.
    const trimmedCompleted = completedText?.trim();
    if (trimmedCompleted && trimmedCompleted !== 'Done.') {
        return trimmedCompleted;
    }
    return streamedText?.trim() ?? trimmedCompleted ?? '';
};
export async function buildConversationResult(input, deps) {
    const { result, finalOutputOverride, reasoningOutputOverride, emittedCommandIds, usage, toolCallArgumentsById } = input;
    const { approvalFlow, shellAutoApproval, logger, sessionId, approvalPolicyRegistry, sessionAccess, nestedCompatibility, } = deps;
    const runBudgetInteraction = result.interruptions?.find(isRunBudgetInteraction);
    if (runBudgetInteraction) {
        approvalFlow.recordPending({
            state: result.state ?? createContinuationHandle(undefined),
            interruption: runBudgetInteraction,
            interruptions: result.interruptions,
            decisionsByCallId: new Map(),
            owner: approvalFlow.resolveOwner(runBudgetInteraction),
            token: input.token,
            inputMode: input.inputMode,
        });
        return {
            kind: 'approval_required',
            result: createApprovalRequiredTerminal({
                agentName: 'System',
                toolName: CHECK_IN_TOOL_NAME,
                checkIn: 'run_budget',
                argumentsText: formatRunBudgetInteraction(runBudgetInteraction.event),
                rawInterruption: runBudgetInteraction,
                usage: usage ?? extractUsage(result),
                costRecords: result.runCostRecords,
                runBudgetEvent: runBudgetInteraction.event,
            }),
        };
    }
    if (result.interruptions && result.interruptions.length > 0) {
        const interruption = result.interruptions[0];
        const interruptionRecord = asRecord(interruption);
        const callId = getCallIdFromObject(interruption);
        const { toolName, argumentsText, rawArguments } = getToolInfoFromInterruption(interruption);
        const parseResult = parseToolCallArguments(rawArguments, {
            callId: callId ?? 'unknown-call-id',
            toolName,
            sessionId,
            traceId: logger.getCorrelationId() ?? 'trace-unknown',
        });
        if (parseResult.invalidJsonDiagnostic) {
            logger.error('Invalid tool call argument payload', {
                ...createInvalidToolCallDiagnostic(parseResult.invalidJsonDiagnostic),
                sessionId,
                messageId: callId ?? 'unknown-call-id',
            });
            throw new ModelBehaviorError(`Error parsing tool arguments for ${toolName}: arguments must be valid JSON.`);
        }
        // If a sandboxed denied-read retry is pending, force the human prompt (no LLM auto-approval)
        // and attach the denied-read metadata so the UI renders the 4-option prompt.
        const shellCommandForDeniedRead = toolName === 'shell' || toolName === 'bash'
            ? parseResult.arguments?.command
            : undefined;
        const deniedReadInfo = typeof shellCommandForDeniedRead === 'string' && nestedCompatibility?.deniedReads.has(shellCommandForDeniedRead)
            ? nestedCompatibility.deniedReads.consume(shellCommandForDeniedRead)
            : null;
        const hasDeniedRead = deniedReadInfo !== null;
        // Re-stage so prepareContinuation can access the info when the user chooses
        // allow-once / allow-remember / unsandboxed-once for this command.
        if (deniedReadInfo && typeof shellCommandForDeniedRead === 'string') {
            nestedCompatibility?.deniedReads.stageForDescriptor(shellCommandForDeniedRead, deniedReadInfo);
        }
        const forceHumanApproval = requiresHumanShellApproval(toolName, parseResult.arguments, sessionId, sessionAccess, nestedCompatibility, {
            // Unsandboxed escapes may be evaluated by the LLM auto-approval path when
            // the sandbox is enabled and auto-approval is in advisory/auto mode.
            llmMayEvaluateUnsandboxed: shellAutoApproval.isUnsandboxedApprovalEligible(),
        }) || hasDeniedRead;
        // Resolved here rather than in the UI: it depends on this session's record of
        // sandbox Docker blocks, and the prompt has no session identity to consult.
        const dockerHostControl = isDockerHostControlShellApproval(toolName, parseResult.arguments, sessionId, sessionAccess, nestedCompatibility);
        const outsideWorkspaceEdit = resolveOutsideWorkspaceEdit(toolName, parseResult.arguments);
        approvalFlow.recordPending({
            state: result.state ?? createContinuationHandle(undefined),
            interruption,
            interruptions: result.interruptions,
            decisionsByCallId: new Map(),
            promptedCallId: callId,
            owner: approvalFlow.resolveOwner(interruption),
            token: input.token,
            inputMode: input.inputMode,
        });
        const agent = asRecord(interruptionRecord?.agent);
        const runContext = asRecord(asRecord(result.state)?._context);
        if (shouldBypassToolApproval(toolName, shellAutoApproval.getAutoApproveMode())) {
            logger.debug('Tool auto-approved in YOLO mode', {
                eventType: 'approval.auto_approved',
                category: 'approval',
                phase: 'approval',
                sessionId,
                callId,
                toolName,
            });
            return {
                kind: 'auto_approve',
                callId,
                argumentsText,
            };
        }
        const registryDecision = await approvalPolicyRegistry.evaluate({
            toolName,
            args: parseResult.arguments,
            context: runContext,
        });
        deps.assertCurrent?.();
        if (registryDecision.kind === 'error' || registryDecision.kind === 'interceptor_denied') {
            logger.warn('Tool approval policy refused a direct call', {
                eventType: 'approval.policy_denied',
                category: 'approval',
                phase: 'approval',
                sessionId,
                callId,
                toolName,
                policy: registryDecision.kind,
            });
            approvalFlow.clearPending();
            throw new ModelBehaviorError(registryDecision.kind === 'error'
                ? `Tool approval policy failed for ${toolName ?? 'the requested tool'}: ${registryDecision.message}; execution was not allowed.`
                : `Tool approval policy ${registryDecision.kind} refused ${toolName ?? 'the requested tool'}; execution was not allowed.`);
        }
        const unknownPolicy = registryDecision.kind === 'unknown';
        if (unknownPolicy) {
            logger.debug('Tool approval policy was unknown; using advisory/manual resolution', {
                eventType: 'approval.policy_unknown',
                category: 'approval',
                phase: 'approval',
                sessionId,
                callId,
                toolName,
            });
        }
        if (!forceHumanApproval &&
            !isUnsandboxedShell(toolName, parseResult.arguments) &&
            registryDecision.kind === 'auto_approve') {
            logger.debug('Tool auto-approved by original tool policy', {
                eventType: 'approval.auto_approved',
                category: 'approval',
                phase: 'approval',
                sessionId,
                callId,
                toolName,
            });
            return {
                kind: 'auto_approve',
                callId,
                argumentsText,
            };
        }
        let llmAdvisory;
        if (isAutoApprovableTool(toolName) && !forceHumanApproval) {
            if (shellAutoApproval.getAutoApproveMode() === 'always') {
                return {
                    kind: 'auto_approve',
                    callId,
                    argumentsText,
                };
            }
            llmAdvisory = await shellAutoApproval.resolveAdvisoryForInterruption({
                interruption,
                siblings: result.interruptions || [],
            });
            deps.assertCurrent?.();
            if (shellAutoApproval.shouldAutoApprove(llmAdvisory)) {
                logger.debug('Tool auto-approved by LLM', {
                    eventType: 'approval.auto_approved',
                    category: 'approval',
                    phase: 'approval',
                    sessionId,
                    callId,
                    toolName,
                    arguments: argumentsText,
                    model: llmAdvisory.model,
                    reasoning: llmAdvisory.reasoning,
                });
                if (supportsFolderSessionRead(toolName)) {
                    const folder = resolveSessionReadFolder(toolName, parseResult.arguments);
                    if (folder && sessionAccess) {
                        sessionAccess.allowReadFolder(folder);
                    }
                }
                if (toolName === 'create_file' || toolName === 'search_replace' || toolName === 'apply_patch') {
                    const targetPaths = extractToolTargetPaths(toolName, parseResult.arguments);
                    if (sessionAccess) {
                        for (const p of targetPaths) {
                            sessionAccess.allowEditFile(p);
                        }
                    }
                }
                return {
                    kind: 'auto_approve',
                    advisory: llmAdvisory,
                    callId,
                    argumentsText,
                };
            }
        }
        return {
            kind: 'approval_required',
            result: createApprovalRequiredTerminal({
                agentName: getString(agent, 'name') ?? 'Agent',
                toolName: toolName ?? 'Unknown Tool',
                argumentsText,
                rawInterruption: interruption,
                callId: callId ? String(callId) : undefined,
                llmAdvisory,
                dockerHostControl,
                outsideWorkspaceEdit,
                usage: usage ?? extractUsage(result),
                costRecords: result.runCostRecords,
                ...(deniedReadInfo
                    ? {
                        deniedRead: {
                            deniedPath: deniedReadInfo.path,
                            suggestedParent: deniedReadInfo.suggestedParent,
                            sensitive: deniedReadInfo.sensitive,
                            command: shellCommandForDeniedRead ?? '',
                        },
                    }
                    : {}),
            }),
        };
    }
    approvalFlow.clearPending();
    shellAutoApproval.clearCache();
    const items = selectAgentStreamItems(result);
    const commandMessageItems = attachCachedArguments(items, toolCallArgumentsById);
    const allCommandMessages = extractCommandMessages(commandMessageItems, deps.toolCallMarkers);
    const derivedTurnItems = buildPersistedAssistantTurnItems(items);
    const commandMessages = emittedCommandIds
        ? allCommandMessages.filter((msg) => !emittedCommandIds.has(msg.id))
        : allCommandMessages;
    const visibleCommandMessages = commandMessages;
    // Note: Previously isApprovalRejection messages were filtered out here, which caused
    // denied shell tool executions to be invisible in the UI. They must be preserved so
    // the frontend can render the attempted command and the denial reason.
    return {
        kind: 'response',
        result: {
            type: 'response',
            commandMessages: visibleCommandMessages,
            finalText: resolveFinalText(finalOutputOverride, result.finalOutput),
            reasoningText: reasoningOutputOverride,
            usage: usage ?? extractUsage(result),
            costRecords: result.runCostRecords,
            turnItems: derivedTurnItems.length > 0 ? derivedTurnItems : input.turnItems,
            ...(result.historyReplacedByCompaction
                ? { providerHistory: result.history }
                : {}),
            ...(result.terminalCause ? { terminalCause: result.terminalCause } : {}),
        },
    };
}
function formatRunBudgetInteraction(event) {
    if (event.type === 'tool_stall') {
        return `Run budget/stall check-in\nRepeated tool call: ${event.toolName} (${event.count}/${event.threshold})`;
    }
    const { evidence } = event;
    return `Run budget ${event.stage} check-in\n${evidence.dimension}: ${evidence.used}/${evidence.limit} (headroom ${evidence.headroom})`;
}
export const toTerminalEvent = (result) => {
    if (result.type === 'approval_required') {
        // Only the private interruption stays runtime-local. Preserve the complete
        // public descriptor, including the token that selects the decision owner.
        const { rawInterruption: _rawInterruption, ...approval } = result.approval;
        return {
            type: 'approval_required',
            approval,
            ...(result.usage ? { usage: result.usage } : {}),
            ...(result.costRecords && result.costRecords.length > 0 ? { costRecords: result.costRecords } : {}),
        };
    }
    return {
        type: 'final',
        finalText: result.finalText,
        ...(result.reasoningText ? { reasoningText: result.reasoningText } : {}),
        ...(result.commandMessages?.length ? { commandMessages: result.commandMessages } : {}),
        ...(result.usage ? { usage: result.usage } : {}),
        ...(result.costRecords && result.costRecords.length > 0 ? { costRecords: result.costRecords } : {}),
        ...(result.turnItems ? { turnItems: result.turnItems } : {}),
        ...('providerHistory' in result && result.providerHistory ? { providerHistory: result.providerHistory } : {}),
        ...(result.terminalCause ? { terminalCause: result.terminalCause } : {}),
    };
};
//# sourceMappingURL=conversation-result-builder.js.map