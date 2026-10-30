import { useMemo } from 'react';
import { useModeHelpers, BARE_ENABLED_DETAIL, createModeToggleCommand, createProfileCommand, } from '../commands/mode-commands.js';
import { createCopySlashCommand } from '../commands/copy-command.js';
import { createUsageSlashCommand } from '../commands/usage-command.js';
import { createClearSlashCommand } from '../commands/clear-command.js';
import { createGoalSlashCommand } from '../commands/goal-command.js';
import { createRewindSlashCommand } from '../commands/rewind-command.js';
import { createRetryToolSlashCommand } from '../commands/retry-tool-command.js';
import { createQuitSlashCommand } from '../commands/quit-command.js';
import { createModelSlashCommand } from '../commands/model-command.js';
import { createAutoApproveSlashCommand } from '../commands/auto-approve-command.js';
import { createSandboxSlashCommand } from '../commands/sandbox-command.js';
import { createMcpLoginCommand } from '../commands/mcp-login-command.js';
import { createMcpStatusCommand } from '../commands/mcp-status-command.js';
import { createEffortSlashCommand } from '../commands/effort-command.js';
import { createHandoffSlashCommand } from '../commands/handoff-command.js';
import { createGuardedSettingsCommand } from '../commands/guarded-settings-command.js';
import { createSkillsSlashCommand } from '../commands/skills-command.js';
import { createCompactSlashCommand } from '../commands/compact-command.js';
import { createRetryFailedTurnSlashCommand } from '../commands/retry-failed-turn-command.js';
import { guardAgainstBusyTurn } from '../utils/busy-turn-guard.js';
import { createResumeSlashCommand } from '../commands/resume-command.js';
import { createBridgeCommand } from '../commands/bridge-command.js';
export const useAppCommands = ({ settingsService, transitionService, addSystemMessage, addDividerMessage = () => undefined, applyRuntimeSetting, replaceInput, clearConversation, getGoal = () => undefined, setGoal = () => undefined, getSessionUsage, refreshProviderUsage, exit, restart, messages, getRewindItems, rewindToTarget, restoreTurnToInput, openRewindMenu, openProvidersMenu, openCopyMenu, onRewind, onHandoff, sendUserMessage, retryLastToolOutput, retryLastFailedTurn = async () => false, compactContext = async () => 'Context compaction is unavailable.', skillsService, onSkillSelected, requestModeSwitchConfirm, turnInFlight = false, listConversations, resumeConversation, mcpManager = null, mcpOAuthStore = null, mcpUserConfigPath, openMcpMenu, controlSocket, controlSocketIsStartup = false, connectControlSocket, disconnectControlSocket, getSessionId = () => 'unknown', }) => {
    const { togglePlanMode, cycleAppModes } = useModeHelpers({
        settingsService,
        transitionService,
        addSystemMessage,
        messages,
        requestModeSwitchConfirm,
    });
    const slashCommands = useMemo(() => {
        // Shared by /rewind and its two aliases so they cannot drift apart.
        const rewindDeps = {
            getRewindItems,
            rewindToTarget,
            restoreTurnToInput,
            sendUserMessage,
            addSystemMessage,
            openRewindMenu,
            onRewind,
        };
        // These actions abort the active turn, replace the conversation, or race
        // it (rewind/retry, retry-tool, clear, quit, compact). Every dispatch
        // path funnels through the command objects, so guarding here covers the
        // typed submit, the intent host, and the slash menu at once.
        const guardBusyTurn = (command) => guardAgainstBusyTurn(command, { turnInFlight: () => turnInFlight, notify: addSystemMessage });
        const commands = [
            createModelSlashCommand({ settingsService, applyRuntimeSetting, addSystemMessage, replaceInput }),
            createEffortSlashCommand({ settingsService, applyRuntimeSetting, addSystemMessage, replaceInput }),
            guardBusyTurn(createClearSlashCommand(clearConversation, addSystemMessage)),
            createGoalSlashCommand({ getGoal, setGoal, addSystemMessage }),
            createCopySlashCommand({ messages, addSystemMessage, openCopyMenu }),
            createUsageSlashCommand(addSystemMessage, getSessionUsage, refreshProviderUsage),
            guardBusyTurn(createResumeSlashCommand({ listConversations, resumeConversation, addSystemMessage, replaceInput })),
            guardBusyTurn(createRewindSlashCommand({
                name: 'rewind',
                defaultDisposition: 'edit',
                bareTarget: 'picker',
                ...rewindDeps,
            })),
            // Aliases keep existing muscle memory working: bare /undo opened a picker
            // and bare /retry acted on the last turn immediately, so each keeps that.
            guardBusyTurn(createRewindSlashCommand({
                name: 'undo',
                aliasOf: 'rewind',
                defaultDisposition: 'edit',
                bareTarget: 'picker',
                ...rewindDeps,
            })),
            guardBusyTurn(createRewindSlashCommand({
                name: 'retry',
                aliasOf: 'rewind',
                defaultDisposition: 'resend',
                bareTarget: 'last',
                ...rewindDeps,
            })),
            guardBusyTurn(createRetryToolSlashCommand({ retryLastToolOutput, addSystemMessage })),
            guardBusyTurn(createRetryFailedTurnSlashCommand({ retryLastFailedTurn, addSystemMessage, addDividerMessage })),
            guardBusyTurn(createCompactSlashCommand({ compactContext, addSystemMessage })),
            ...['bare', 'lite'].map((name) => createModeToggleCommand('bare', name, name === 'lite'
                ? 'Toggle the Bare profile (Lite was merged into Bare)'
                : 'Toggle the Bare profile (minimal prompt)', BARE_ENABLED_DETAIL, {
                settingsService,
                transitionService,
                addSystemMessage,
                messages,
                requestModeSwitchConfirm,
            })),
            createModeToggleCommand('mentor', 'mentor', 'Toggle mentor mode (collaborative mode with mentor model)', ' - using simplified mentor prompt and ask_mentor tool', {
                settingsService,
                transitionService,
                addSystemMessage,
                messages,
            }),
            createModeToggleCommand('orchestrator', 'orchestrator', 'Toggle orchestrator mode (delegate all tool-backed work)', ' - tool-backed work must use subagents', {
                settingsService,
                transitionService,
                addSystemMessage,
                messages,
            }),
            createAutoApproveSlashCommand({ settingsService, applyRuntimeSetting, addSystemMessage, replaceInput }),
            {
                name: 'plan',
                description: 'Toggle plan mode (read-only research/planning mode)',
                action: () => {
                    togglePlanMode();
                    return true;
                },
            },
            createProfileCommand({
                settingsService,
                transitionService,
                addSystemMessage,
                replaceInput,
                messages,
                requestModeSwitchConfirm,
            }),
            createHandoffSlashCommand({ messages, addSystemMessage, onHandoff }),
            createGuardedSettingsCommand({
                settingsService,
                addSystemMessage,
                applyRuntimeSetting,
                replaceInput,
                messages,
                requestModeSwitchConfirm,
            }),
            createSandboxSlashCommand({ settingsService, applyRuntimeSetting, addSystemMessage }),
            createMcpStatusCommand({
                manager: mcpManager,
                ...(mcpUserConfigPath !== undefined ? { userConfigPath: mcpUserConfigPath } : {}),
                addSystemMessage,
                openMcpMenu,
            }),
            createMcpLoginCommand({ manager: mcpManager, store: mcpOAuthStore, addSystemMessage }),
            guardBusyTurn(createBridgeCommand({
                getServer: () => controlSocket,
                isStartup: controlSocketIsStartup,
                connect: connectControlSocket,
                disconnect: disconnectControlSocket,
                getSessionId,
                addSystemMessage,
            })),
            {
                name: 'providers',
                description: 'Manage API providers (list, add, edit, delete)',
                action: () => {
                    openProvidersMenu();
                    return true;
                },
            },
            createSkillsSlashCommand({ skillsService, onSkillSelected, addSystemMessage, replaceInput }),
            {
                name: 'restart',
                description: 'Reload the built CLI in place; /restart stop consents to stopping background work',
                action: (args) => {
                    if (args?.trim() && args.trim() !== 'stop') {
                        addSystemMessage('Usage: /restart [stop]');
                        return false;
                    }
                    void restart?.(args?.trim() === 'stop').catch((error) => {
                        addSystemMessage(`Restart refused: ${error instanceof Error ? error.message : String(error)}`);
                    });
                    return true;
                },
            },
            guardBusyTurn(createQuitSlashCommand(exit)),
        ];
        commands.push({
            name: 'help',
            description: 'Show commands and keyboard shortcuts',
            action: () => {
                const commandLines = commands
                    .filter(({ name }) => name !== 'undo')
                    .map(({ name, description }) => `/${name} — ${description}`)
                    .join('\n');
                addSystemMessage(`Commands\n${commandLines}\n\nKeyboard shortcuts\nCtrl+C: clear draft or interrupt; press again to exit\nCtrl+O: choose model · Ctrl+T: choose reasoning effort\nShift+Tab: switch Standard/Plan · @: complete paths · !: shell`);
                return true;
            },
        });
        return commands;
    }, [
        addSystemMessage,
        applyRuntimeSetting,
        clearConversation,
        getGoal,
        setGoal,
        exit,
        restart,
        getSessionUsage,
        refreshProviderUsage,
        mcpManager,
        mcpOAuthStore,
        mcpUserConfigPath,
        openMcpMenu,
        messages,
        replaceInput,
        settingsService,
        transitionService,
        getRewindItems,
        rewindToTarget,
        restoreTurnToInput,
        openRewindMenu,
        openProvidersMenu,
        openCopyMenu,
        onRewind,
        onHandoff,
        sendUserMessage,
        retryLastToolOutput,
        retryLastFailedTurn,
        compactContext,
        togglePlanMode,
        skillsService,
        onSkillSelected,
        requestModeSwitchConfirm,
        turnInFlight,
        listConversations,
        resumeConversation,
        controlSocket,
        controlSocketIsStartup,
        connectControlSocket,
        disconnectControlSocket,
        getSessionId,
    ]);
    return {
        slashCommands,
        togglePlanMode,
        cycleAppModes,
    };
};
//# sourceMappingURL=use-app-commands.js.map