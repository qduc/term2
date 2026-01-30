import test from 'ava';
import React from 'react';
import {render} from 'ink-testing-library';
import ModelSelectionMenu from './ModelSelectionMenu.js';
import {createMockSettingsService} from '../services/settings-service.mock.js';

test('ModelSelectionMenu renders provider tabs even when error occurs', t => {
    // OpenAI is a default provider
    const settingsService = createMockSettingsService();

    const {lastFrame} = render(
        <ModelSelectionMenu
            settingsService={settingsService}
            items={[]}
            selectedIndex={0}
            query=""
            error="Failed to fetch models"
            provider="openai"
        />,
    );

    const output = lastFrame();
    t.true(output?.includes('Unable to load models: Failed to fetch models'));
    // Should verify that provider tabs are still visible
    // "OpenAI" shows up as a label in the tabs
    t.true(output?.includes('OpenAI'));
    // And possibly the switch instruction
    t.true(output?.includes('Tab → switch provider'));
});
