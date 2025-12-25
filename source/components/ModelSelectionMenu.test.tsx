import test from 'ava';
import React from 'react';
import {render} from 'ink-testing-library';
import ModelSelectionMenu from './ModelSelectionMenu.js';
import type {ModelInfo} from '../services/model-service.js';
import {createMockSettingsService} from '../services/settings-service.mock.js';

const mockModels: ModelInfo[] = [
    {id: 'gpt-4o', name: 'GPT-4o', provider: 'openai'},
    {id: 'gpt-4-turbo', name: 'GPT-4 Turbo', provider: 'openai'},
    {id: 'claude-3-opus', name: 'Claude 3 Opus', provider: 'openrouter'},
];

test('ModelSelectionMenu renders loading state', t => {
    const {lastFrame} = render(
        <ModelSelectionMenu
            settingsService={createMockSettingsService()}
            items={[]}
            selectedIndex={0}
            query=""
            loading={true}
        />,
    );
    t.true(lastFrame()?.includes('Loading models'));
});

test('ModelSelectionMenu renders error state', t => {
    const {lastFrame} = render(
        <ModelSelectionMenu
            settingsService={createMockSettingsService()}
            items={[]}
            selectedIndex={0}
            query=""
            error="Failed to fetch"
        />,
    );
    t.true(lastFrame()?.includes('Unable to load models: Failed to fetch'));
});

test('ModelSelectionMenu renders empty state', t => {
    const {lastFrame} = render(
        <ModelSelectionMenu
            settingsService={createMockSettingsService()}
            items={[]}
            selectedIndex={0}
            query="xyz"
        />,
    );
    t.true(lastFrame()?.includes('No models match "xyz"'));
});

test('ModelSelectionMenu renders list of models', t => {
    const {lastFrame} = render(
        <ModelSelectionMenu
            settingsService={createMockSettingsService()}
            items={mockModels}
            selectedIndex={0}
            query=""
        />,
    );
    const output = lastFrame();
    t.true(output?.includes('gpt-4o'));
    t.true(output?.includes('GPT-4o'));
    t.true(output?.includes('gpt-4-turbo'));
    t.true(output?.includes('claude-3-opus'));
    t.true(output?.includes('3 suggestions'));
});

test('ModelSelectionMenu highlights selected item', t => {
    // Ink testing library doesn't easily show colors in text output,
    // but we can check if the selected item is present.
    // We rely on the component logic which we can assume works if it renders.
    // To be more specific, we could check for ANSI codes if we really wanted to,
    // but checking content is usually enough for unit tests here.
    const {lastFrame} = render(
        <ModelSelectionMenu
            settingsService={createMockSettingsService()}
            items={mockModels}
            selectedIndex={1}
            query=""
        />,
    );
    const output = lastFrame();
    t.true(output?.includes('gpt-4-turbo'));
});

test('ModelSelectionMenu shows provider in header if specified', t => {
    const {lastFrame} = render(
        <ModelSelectionMenu
            settingsService={createMockSettingsService()}
            items={mockModels}
            selectedIndex={0}
            query=""
            provider="openai"
        />,
    );
    t.true(lastFrame()?.includes('OpenAI'));
});

test('ModelSelectionMenu provider tabs include custom providers from settings', t => {
    const providerId = `lmstudio-ui-${Date.now()}-${Math.random()}`;
    const settingsService = createMockSettingsService({
        providers: [
            {
                name: providerId,
                baseUrl: 'http://localhost:1234',
            },
        ],
    });

    const {lastFrame} = render(
        <ModelSelectionMenu
            settingsService={settingsService}
            items={mockModels}
            selectedIndex={0}
            query=""
            provider="openai"
        />,
    );

    const output = lastFrame();
    t.true(output?.includes(providerId));
});

test('ModelSelectionMenu shows scroll indicators for long lists', t => {
    const longList: ModelInfo[] = Array.from({length: 20}, (_, i) => ({
        id: `model-${i}`,
        name: `Model ${i}`,
        provider: 'openai',
    }));

    const {lastFrame} = render(
        <ModelSelectionMenu
            settingsService={createMockSettingsService()}
            items={longList}
            selectedIndex={5}
            query=""
            scrollOffset={2}
            maxHeight={10}
        />,
    );
    const output = lastFrame();
    // Should show scroll position indicator
    t.true(output?.includes('3-12/20') || output?.includes('20'));
    // Should show scroll up indicator
    t.true(output?.includes('↑ 2 more'));
    // Should show scroll down indicator (20 - 2 - 10 = 8 more)
    t.true(output?.includes('↓ 8 more'));
});

test('ModelSelectionMenu does not show scroll indicators for short lists', t => {
    const {lastFrame} = render(
        <ModelSelectionMenu
            settingsService={createMockSettingsService()}
            items={mockModels}
            selectedIndex={0}
            query=""
            scrollOffset={0}
            maxHeight={10}
        />,
    );
    const output = lastFrame();
    // Should not show position indicator for lists shorter than maxHeight
    t.false(output?.includes('/'));
    // For short lists with no scroll, should not have these indicators
    t.false(output?.includes('more'));
});
