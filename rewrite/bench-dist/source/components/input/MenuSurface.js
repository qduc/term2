import React, { useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { useInputContext } from '../../context/InputContext.js';
import { MenuStackHost } from './MenuStackHost.js';
import { useTheme } from '../theme.js';
import { getSettingLabel, isSecretSetting } from '../../services/settings/settings-ui-metadata.js';
const isFocusReportingSequence = (input) => input === '\x1b[I' || input === '\x1b[O' || input === '[I' || input === '[O';
const filterableMenuKinds = new Set([
    'slash',
    'path',
    'settings',
    'settings_value',
    'model',
    'skills',
    'profile',
]);
const isFilterableMenu = (frame) => frame !== undefined && filterableMenuKinds.has(frame.kind);
const isSettingsValueMenu = (frame) => frame?.kind === 'settings_value';
/** The sole terminal input boundary while a controller menu is visible. */
export function MenuSurface({ stack, controller, interactions, services, enabled }) {
    const theme = useTheme();
    const { input, cursorOffset, menuPromptLabel, setCursorOverride } = useInputContext();
    const activeFrame = stack.at(-1);
    const filterFrame = isFilterableMenu(activeFrame) ? activeFrame : undefined;
    const valueFrame = isSettingsValueMenu(activeFrame) ? activeFrame : undefined;
    // A settings_value frame edits a value, not a filter: label the line with
    // the setting name (which the binding text itself omits) instead of "Filter:".
    // A credential being typed is masked, so it never shows on screen.
    const promptLabel = valueFrame
        ? `${getSettingLabel(valueFrame.settingKey)} = `
        : filterFrame
            ? 'Filter: '
            : menuPromptLabel;
    const valueQuery = valueFrame && isSecretSetting(valueFrame.settingKey)
        ? '•'.repeat(valueFrame.binding.query.length)
        : valueFrame?.binding.query;
    const promptText = valueQuery ?? filterFrame?.binding.query ?? (menuPromptLabel ? input : undefined);
    useEffect(() => {
        if (enabled)
            setCursorOverride(cursorOffset);
    }, [cursorOffset, enabled, setCursorOverride]);
    const dispatch = (event) => {
        controller.dispatchActiveEvent(event);
        setCursorOverride(controller.getSnapshot().editor.cursor);
    };
    useInput((_input, key) => {
        if (!enabled || controller.getSnapshot().stack.length === 0)
            return;
        if (isFocusReportingSequence(_input))
            return;
        const historyNavigation = services.historyNavigation;
        if (activeFrame?.kind === 'slash' && historyNavigation?.isNavigating && (key.upArrow || key.downArrow)) {
            const next = key.upArrow ? historyNavigation.navigateUp(input) : historyNavigation.navigateDown();
            if (next)
                controller.replaceText(next.text, next.text.length);
        }
        else if (key.upArrow) {
            dispatch({ type: 'move', direction: 'up' });
        }
        else if (key.downArrow) {
            dispatch({ type: 'move', direction: 'down' });
        }
        else if (key.pageUp) {
            dispatch({ type: 'move', direction: 'page-up' });
        }
        else if (key.pageDown) {
            dispatch({ type: 'move', direction: 'page-down' });
        }
        else if (key.home) {
            dispatch({ type: 'move', direction: 'home' });
        }
        else if (key.end) {
            dispatch({ type: 'move', direction: 'end' });
        }
        else if (key.tab && !key.shift) {
            dispatch({ type: 'command', command: 'tab' });
        }
        else if (key.ctrl && _input === 'r') {
            dispatch({ type: 'command', command: 'refresh' });
        }
        else if (key.ctrl && _input === 'd') {
            dispatch({ type: 'command', command: 'reset' });
        }
        else if (key.ctrl && _input.toLowerCase() === 'f') {
            dispatch({ type: 'command', command: 'favorite' });
        }
        else if (key.ctrl && _input.toLowerCase() === 'n') {
            dispatch({ type: 'command', command: 'nickname' });
        }
        else if ((key.ctrl && (_input.toLowerCase() === 'o' || _input === '\x0f')) || _input === '\x0f') {
            controller.replaceText('/model ');
        }
        else if ((key.ctrl && (_input.toLowerCase() === 't' || _input === '\x14')) || _input === '\x14') {
            controller.replaceText('/effort ');
        }
        else if (key.return) {
            dispatch({
                type: 'accept',
                input: { kind: 'composer', text: input, cursor: cursorOffset },
                selected: undefined,
            });
        }
        else if (key.backspace) {
            dispatch({ type: 'command', command: 'backspace' });
        }
        else if (key.delete) {
            dispatch({ type: 'command', command: 'delete' });
        }
        else if (key.leftArrow) {
            dispatch({ type: 'command', command: 'left' });
        }
        else if (key.rightArrow) {
            dispatch({ type: 'command', command: 'right' });
        }
        else if (_input &&
            !key.ctrl &&
            !key.meta &&
            !key.escape &&
            !key.tab &&
            !key.return &&
            !key.upArrow &&
            !key.downArrow &&
            !key.leftArrow &&
            !key.rightArrow) {
            dispatch({ type: 'input', text: _input });
        }
    }, { isActive: enabled });
    return (React.createElement(Box, { flexDirection: "column" },
        promptLabel && (React.createElement(Box, { marginBottom: 0 },
            React.createElement(Text, { color: theme.accent, bold: true }, promptLabel),
            React.createElement(Text, { color: theme.text }, promptText))),
        React.createElement(MenuStackHost, { stack: stack, controller: controller, interactions: interactions, services: services, enabled: enabled })));
}
//# sourceMappingURL=MenuSurface.js.map