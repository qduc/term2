import React, { useEffect } from 'react';
import { useInput } from 'ink';
import InputBox from '../InputBox.js';
import { useInputContext } from '../../context/InputContext.js';
import { useInputHistory } from '../../hooks/use-input-history.js';
import { useSlashCommands } from '../../hooks/use-slash-commands.js';
import { usePathCompletion } from '../../hooks/use-path-completion.js';
import { useSettingsCompletion } from '../../hooks/use-settings-completion.js';
import { useSettingsValueCompletion } from '../../hooks/use-settings-value-completion.js';
import { useModelSelection } from '../../hooks/use-model-selection.js';
import { useSkillSelection } from '../../hooks/use-skill-selection.js';
import { useProfileSelection } from '../../hooks/use-profile-selection.js';
import { useResumeSelection } from '../../hooks/use-resume-selection.js';
import { createDefaultTriggerRegistry } from './triggers.js';
import { MenuSurface } from './MenuSurface.js';
const emptyConversations = async () => [];
const ApplicationInputSurface = (props) => {
    const enabled = props.enabled ?? true;
    const { controller, interactions, stack, cursorOffset, cursorOverride, setCursorOverride, inputReplacementRevision } = useInputContext();
    const historyNavigation = useInputHistory(props.historyService);
    const { reset: resetHistory } = historyNavigation;
    useEffect(() => resetHistory(), [inputReplacementRevision, resetHistory]);
    const slash = useSlashCommands({ commands: props.slashCommands, onClose: () => { } });
    const path = usePathCompletion({ loggingService: props.loggingService });
    const settings = useSettingsCompletion(props.settingsService);
    const settingsValue = useSettingsValueCompletion(props.settingsService);
    const models = useModelSelection({ loggingService: props.loggingService, settingsService: props.settingsService });
    const skills = useSkillSelection({
        skillsService: props.skillsService ?? { getAvailableSkills: () => [] },
    });
    const resume = useResumeSelection({
        listConversations: props.listConversations ?? emptyConversations,
    });
    const profiles = useProfileSelection({ settingsService: props.settingsService });
    useEffect(() => {
        controller.setTriggerRegistry(createDefaultTriggerRegistry(props.slashCommands, [
            'slash',
            'path',
            'skills',
            'profile',
            'resume',
            'settings',
            'settings-value-child',
            'settings-subagent-pool-child',
            'settings-model',
            'command-model',
            'direct-setting-value',
        ]));
    }, [controller, props.slashCommands]);
    // MenuSurface is intentionally unmounted while the editor is active. Carry
    // the controller cursor through that handoff once so MultilineInput does not
    // snap back to the end of a value that was edited in the middle.
    useEffect(() => {
        if (stack.length === 0 && cursorOverride !== null && cursorOverride !== cursorOffset) {
            setCursorOverride(cursorOffset);
        }
    }, [cursorOffset, cursorOverride, setCursorOverride, stack.length]);
    // Keep Escape subscribed across the editor/menu remount. A key can arrive
    // after the controller opens a menu but before the replacement surface's
    // passive input effect is installed; the controller snapshot is the only
    // authoritative owner during that handoff.
    useInput((_input, key) => {
        if (!enabled || !key.escape)
            return;
        if (controller.getSnapshot().stack.length === 0)
            return;
        controller.escape();
        setCursorOverride(controller.getSnapshot().editor.cursor);
    }, { isActive: true });
    const services = {
        settingsService: props.settingsService,
        loggingService: props.loggingService,
        slash,
        historyNavigation,
        path,
        skills,
        profiles,
        resume,
        settings,
        settingsValue,
        models,
        onProviderSelected: props.onProviderSelected,
        onUnavailableModelSelected: props.onUnavailableModelSelected,
        onSkillSelected: props.onSkillSelected,
        onCopySelection: props.onCopySelection,
        onSystemMessage: props.onSystemMessage,
        onResumeConversation: props.resumeConversation,
        mcpManager: props.mcpManager,
        mcpConfigController: props.mcpConfigController,
    };
    if (stack.length > 0) {
        return (React.createElement(MenuSurface, { stack: stack, controller: controller, interactions: interactions, services: services, enabled: enabled }));
    }
    if (!enabled)
        return null;
    const { enabled: _enabled, ...inputBoxProps } = props;
    return (React.createElement(InputBox, { ...inputBoxProps, historyNavigation: historyNavigation, 
        // A newly mounted editor must receive the post-menu cursor in its first
        // render; waiting for an effect lets ink-prompt initialize at the end.
        cursorOverride: cursorOverride !== null ? cursorOffset : null }));
};
export default ApplicationInputSurface;
//# sourceMappingURL=ApplicationInputSurface.js.map