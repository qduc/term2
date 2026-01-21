import test from 'ava';
import React from 'react';
import {render} from 'ink-testing-library';
import SettingsValueSelectionMenu from './SettingsValueSelectionMenu.js';
import type {SettingValueSuggestion} from '../hooks/use-settings-value-completion.js';

const suggestions: SettingValueSuggestion[] = [
    {value: 'low', description: 'Lower reasoning cost'},
    {value: 'medium', description: 'Balanced'},
    {value: 'high', description: 'Highest reasoning'},
];

test('SettingsValueSelectionMenu renders empty state', t => {
    const {lastFrame} = render(
        <SettingsValueSelectionMenu
            settingKey="agent.reasoningEffort"
            items={[]}
            selectedIndex={0}
            query="zzz"
        />,
    );
    t.true(lastFrame()?.includes('No values match'));
    t.true(lastFrame()?.includes('zzz'));
});

test('SettingsValueSelectionMenu shows key and suggestion count', t => {
    const {lastFrame} = render(
        <SettingsValueSelectionMenu
            settingKey="agent.reasoningEffort"
            items={suggestions}
            selectedIndex={0}
            query=""
        />,
    );
    const output = lastFrame() ?? '';
    t.true(output.includes('agent.reasoningEffort'));
    t.true(output.includes('3 suggestion'));
});

test('SettingsValueSelectionMenu marks the selected value', t => {
    const {lastFrame} = render(
        <SettingsValueSelectionMenu
            settingKey="agent.reasoningEffort"
            items={suggestions}
            selectedIndex={2}
            query=""
        />,
    );
    const output = lastFrame() ?? '';
    t.true(output.includes('▶'));
    t.true(output.includes('high'));
});
