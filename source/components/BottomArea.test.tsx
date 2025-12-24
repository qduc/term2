import test from 'ava';
import React from 'react';
import {render} from 'ink-testing-library';
import {InputProvider} from '../context/InputContext.js';
import BottomArea, {type BottomAreaProps} from './BottomArea.js';
import {createMockSettingsService} from '../services/settings-service.mock.js';
import type {SlashCommand} from './SlashCommandMenu.js';

const mockSlashCommands: SlashCommand[] = [
    {name: '/clear', description: 'Clear screen', action: () => {}},
];

const baseProps: BottomAreaProps = {
    pendingApproval: null,
    waitingForApproval: false,
    waitingForRejectionReason: false,
    isProcessing: false,
    onSubmit: async () => {},
    slashCommands: mockSlashCommands,
    onHistoryUp: () => {},
    onHistoryDown: () => {},
    hasConversationHistory: false,
    settingsService: createMockSettingsService(),
    loggingService: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
        security: () => {},
        setCorrelationId: () => {},
        clearCorrelationId: () => {},
    } as any,
    onApprove: () => { },
    onReject: () => { },
};

const renderBottomArea = (props: typeof baseProps) =>
    render(
        <InputProvider>
            <BottomArea {...props} />
        </InputProvider>,
    );

test('BottomArea shows input when idle', t => {
    const {lastFrame} = renderBottomArea(baseProps);
    const output = lastFrame() ?? '';
    t.true(output.includes('❯'));
    t.false(output.includes('processing'));
    t.false(output.includes('Allow this action?'));
});

test('BottomArea shows approval prompt when waiting for approval', t => {
    const {lastFrame} = renderBottomArea({
        ...baseProps,
        pendingApproval: {
            agentName: 'Agent',
            toolName: 'shell',
            argumentsText: '{"commands":"ls"}',
            rawInterruption: null,
        },
        waitingForApproval: true,
    });
    const output = lastFrame() ?? '';
    t.true(output.includes('Allow this action?'));
    t.true(output.includes('Approve'));
    t.true(output.includes('Reject'));
    t.false(output.includes('processing'));
    t.false(output.includes('❯'));
});

test('BottomArea shows processing indicator when busy', t => {
    const {lastFrame} = renderBottomArea({
        ...baseProps,
        isProcessing: true,
    });
    const output = lastFrame() ?? '';
    t.true(output.includes('processing.'));
    t.false(output.includes('Allow this action?'));
    t.false(output.includes('❯'));
});
