// @ts-expect-error IS_REACT_ACT_ENVIRONMENT is not in globalThis types
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import { it, expect } from 'vitest';
import React, { act, useEffect } from 'react';
import { render } from 'ink-testing-library';
import { useProviderSelection } from './use-provider-selection.js';
import { InputProvider, useInputContext } from '../context/InputContext.js';

const TestComponent = ({
  settingsService,
  onHookResult,
  onInputValue,
}: {
  settingsService: any;
  onHookResult: (hook: ReturnType<typeof useProviderSelection>) => void;
  onInputValue?: (value: string) => void;
}) => {
  const hook = useProviderSelection(settingsService);
  const { input } = useInputContext();

  useEffect(() => {
    onHookResult(hook);
  });

  useEffect(() => {
    onInputValue?.(input);
  });

  return null;
};

const flush = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
};

function createMockSettingsService(initialProviders: any[] = [], initialActive = 'openai') {
  const settings = new Map<string, any>([
    ['providers', initialProviders],
    ['agent.provider', initialActive],
  ]);

  return {
    get: (key: string) => settings.get(key),
    set: (key: string, value: any) => settings.set(key, value),
    setPersistent: (key: string, value: any) => settings.set(key, value),
  } as any;
}

it.sequential('useProviderSelection - lists registered and custom providers on open', async () => {
  const customProviders = [{ name: 'custom-ollama', type: 'openai-compatible', baseUrl: 'http://localhost:11434/v1' }];
  const settingsService = createMockSettingsService(customProviders, 'openai');
  let hook: ReturnType<typeof useProviderSelection> | undefined;
  let renderer: any;

  await act(async () => {
    renderer = render(
      React.createElement(
        InputProvider as any,
        {},
        React.createElement(TestComponent, {
          settingsService,
          onHookResult: (h) => {
            hook = h;
          },
        }),
      ),
    );
  });

  expect(hook !== undefined).toBe(true);

  await act(async () => {
    hook!.open();
  });
  await flush();

  expect(hook!.phase).toBe('list');
  const items = hook!.items;
  expect(items.some((item) => item.id === 'openai' && !item.isCustom && item.isActive)).toBe(true);
  expect(items.some((item) => item.id === 'custom-ollama' && item.isCustom && !item.isActive)).toBe(true);

  await act(async () => {
    renderer.unmount();
  });
});

it.sequential('useProviderSelection - selecting a custom provider opens edit_fields directly', async () => {
  const customProviders = [{ name: 'custom-ollama', type: 'openai-compatible', baseUrl: 'http://localhost:11434/v1' }];
  const settingsService = createMockSettingsService(customProviders, 'openai');
  let hook: ReturnType<typeof useProviderSelection> | undefined;
  let renderer: any;

  await act(async () => {
    renderer = render(
      React.createElement(
        InputProvider as any,
        {},
        React.createElement(TestComponent, {
          settingsService,
          onHookResult: (h) => {
            hook = h;
          },
        }),
      ),
    );
  });

  await act(async () => {
    hook!.open();
  });
  await flush();

  // Test selecting custom-ollama
  await act(async () => {
    const active = hook!.getActiveItems();
    const targetIdx = active.findIndex((item) => item.kind === 'provider' && item.id === 'custom-ollama');
    let moves = 0;
    for (let i = 0; i < targetIdx; i++) {
      if (!(active[i]!.kind === 'provider' && (active[i] as any).id === 'codex')) {
        moves++;
      }
    }
    for (let i = 0; i < moves; i++) {
      hook!.moveDown();
    }
  });
  await flush();

  await act(async () => {
    hook!.selectItem();
  });
  await flush();

  expect(hook!.phase).toBe('edit_fields');
  expect(hook!.selectedIndex).toBe(0);
  expect(hook!.draft?.name).toBe('custom-ollama');
  expect(hook!.draft?.baseUrl).toBe('http://localhost:11434/v1');

  await act(async () => {
    renderer.unmount();
  });
});

it.sequential(
  'useProviderSelection - selecting a built-in provider (except Codex) enters editing flow; Codex is a no-op',
  async () => {
    const settingsService = createMockSettingsService([], 'openai');
    let hook: ReturnType<typeof useProviderSelection> | undefined;
    let renderer: any;

    await act(async () => {
      renderer = render(
        React.createElement(
          InputProvider as any,
          {},
          React.createElement(TestComponent, {
            settingsService,
            onHookResult: (h) => {
              hook = h;
            },
          }),
        ),
      );
    });

    await act(async () => {
      hook!.open();
    });
    await flush();

    // Verify Codex is skipped by keyboard navigation
    const active = hook!.getActiveItems();
    const codexIdx = active.findIndex((item) => item.kind === 'provider' && item.id === 'codex');
    expect(codexIdx !== -1).toBe(true);

    // Let's verify that navigating moveDown starting from index 0 skips codexIdx
    expect(hook!.selectedIndex).toBe(0); // Start at OpenAI

    // Move down a fixed number of times. We should never land on codexIdx!
    const visitedIndices = new Set<number>();
    await act(async () => {
      for (let i = 0; i < active.length; i++) {
        visitedIndices.add(hook!.selectedIndex);
        hook!.moveDown();
      }
    });
    await flush();

    expect(visitedIndices.has(codexIdx), 'Keyboard navigation should skip Codex').toBe(false);

    // Navigate to OpenAI (first item, idx 0) and select it
    await act(async () => {
      for (let i = 0; i < active.length; i++) {
        if (hook!.selectedIndex === 0) break;
        hook!.moveUp();
      }
    });
    await flush();

    await act(async () => {
      hook!.selectItem();
    });
    await flush();

    // OpenAI opens edit_fields
    expect(hook!.phase).toBe('edit_fields');
    expect(hook!.selectedIndex).toBe(2); // API Key is selected
    expect(hook!.draft?.name).toBe('OpenAI');

    // Verify we can edit API Key and save it
    await act(async () => {
      hook!.selectItem(); // select API Key at index 2
    });
    await flush();
    expect(hook!.phase).toBe('wizard_key');

    await act(async () => {
      hook!.handleTextInputSubmit('sk-mock-openai-key');
    });
    await flush();
    expect(hook!.phase).toBe('edit_fields');
    expect(hook!.selectedIndex).toBe(2); // Selected row is API Key row

    await act(async () => {
      hook!.moveDown(); // Move to "Save Changes" at index 3
    });
    await flush();
    expect(hook!.selectedIndex).toBe(3);

    await act(async () => {
      hook!.selectItem(); // Save Changes
    });
    await flush();

    expect(hook!.phase).toBe('list');
    expect(settingsService.get('agent.openai.apiKey')).toBe('sk-mock-openai-key');

    await act(async () => {
      renderer.unmount();
    });
  },
);

it.sequential('useProviderSelection - requestDelete on a custom provider opens confirm_delete', async () => {
  const customProviders = [{ name: 'custom-ollama', type: 'openai-compatible', baseUrl: 'http://localhost:11434/v1' }];
  const settingsService = createMockSettingsService(customProviders, 'openai');
  let hook: ReturnType<typeof useProviderSelection> | undefined;
  let renderer: any;

  await act(async () => {
    renderer = render(
      React.createElement(
        InputProvider as any,
        {},
        React.createElement(TestComponent, {
          settingsService,
          onHookResult: (h) => {
            hook = h;
          },
        }),
      ),
    );
  });

  await act(async () => {
    hook!.open();
  });
  await flush();

  // Navigate to custom-ollama
  await act(async () => {
    const active = hook!.getActiveItems();
    const targetIdx = active.findIndex((item) => item.kind === 'provider' && item.id === 'custom-ollama');
    let moves = 0;
    for (let i = 0; i < targetIdx; i++) {
      if (!(active[i]!.kind === 'provider' && (active[i] as any).id === 'codex')) {
        moves++;
      }
    }
    for (let i = 0; i < moves; i++) {
      hook!.moveDown();
    }
  });
  await flush();

  await act(async () => {
    hook!.requestDelete();
  });
  await flush();

  expect(hook!.phase).toBe('confirm_delete');
  // Default cursor should be on "No, keep it" for safety.
  expect(hook!.selectedIndex).toBe(1);

  // Confirming "No, keep it" returns to the list.
  await act(async () => {
    hook!.selectItem();
  });
  await flush();
  expect(hook!.phase).toBe('list');
  expect(settingsService.get('providers').length).toBe(1);

  // Now request delete again, this time confirm "Yes".
  await act(async () => {
    const active = hook!.getActiveItems();
    const targetIdx = active.findIndex((item) => item.kind === 'provider' && item.id === 'custom-ollama');
    let moves = 0;
    for (let i = 0; i < targetIdx; i++) {
      if (!(active[i]!.kind === 'provider' && (active[i] as any).id === 'codex')) {
        moves++;
      }
    }
    for (let i = 0; i < moves; i++) {
      hook!.moveDown();
    }
  });
  await flush();
  await act(async () => {
    hook!.requestDelete();
  });
  await flush();
  expect(hook!.phase).toBe('confirm_delete');

  await act(async () => {
    hook!.moveUp(); // move from default "No" to "Yes"
  });
  await flush();
  expect(hook!.selectedIndex).toBe(0);

  await act(async () => {
    hook!.selectItem();
  });
  await flush();
  expect(hook!.phase).toBe('list');
  expect(settingsService.get('providers').length).toBe(0);
  expect(settingsService.get('agent.provider')).toBe('openai');

  await act(async () => {
    renderer.unmount();
  });
});

it.sequential('useProviderSelection - requestDelete on a built-in is a no-op', async () => {
  const settingsService = createMockSettingsService([], 'openai');
  let hook: ReturnType<typeof useProviderSelection> | undefined;
  let renderer: any;

  await act(async () => {
    renderer = render(
      React.createElement(
        InputProvider as any,
        {},
        React.createElement(TestComponent, {
          settingsService,
          onHookResult: (h) => {
            hook = h;
          },
        }),
      ),
    );
  });

  await act(async () => {
    hook!.open();
  });
  await flush();

  // openai is at index 0 in the built-ins.
  await act(async () => {
    hook!.requestDelete();
  });
  await flush();

  expect(hook!.phase).toBe('list');

  await act(async () => {
    renderer.unmount();
  });
});

it.sequential('useProviderSelection - add provider wizard flow and validation', async () => {
  const settingsService = createMockSettingsService([], 'openai');
  let hook: ReturnType<typeof useProviderSelection> | undefined;
  let renderer: any;

  await act(async () => {
    renderer = render(
      React.createElement(
        InputProvider as any,
        {},
        React.createElement(TestComponent, {
          settingsService,
          onHookResult: (h) => {
            hook = h;
          },
        }),
      ),
    );
  });

  await act(async () => {
    hook!.open();
  });
  await flush();

  // Select "Add Custom Provider" which is at the end of the list
  await act(async () => {
    const active = hook!.getActiveItems();
    const targetIdx = active.findIndex((item) => item.kind === 'add-provider');
    let moves = 0;
    for (let i = 0; i < targetIdx; i++) {
      if (!(active[i]!.kind === 'provider' && (active[i] as any).id === 'codex')) {
        moves++;
      }
    }
    for (let i = 0; i < moves; i++) {
      hook!.moveDown();
    }
  });
  await flush();

  await act(async () => {
    hook!.selectItem();
  });
  await flush();

  expect(hook!.phase).toBe('wizard_name');

  // Submit valid name (validation is tested in provider-service.test.ts)
  let success = false;
  await act(async () => {
    success = hook!.handleTextInputSubmit('my-custom-provider');
  });
  await flush();
  expect(success).toBe(true);
  expect(hook!.phase).toBe('wizard_type');
  expect(hook!.draft?.name).toBe('my-custom-provider');

  // Select first type (openai-compatible)
  await act(async () => {
    hook!.selectItem();
  });
  await flush();
  expect(hook!.phase).toBe('wizard_url');
  expect(hook!.draft?.type).toBe('openai-compatible');

  // Submit valid URL (URL validation is tested in provider-service.test.ts)
  await act(async () => {
    success = hook!.handleTextInputSubmit('http://localhost:8000/v1');
  });
  await flush();
  expect(success).toBe(true);
  expect(hook!.phase).toBe('wizard_key');
  expect(hook!.draft?.baseUrl).toBe('http://localhost:8000/v1');

  // Submit empty API Key (success)
  await act(async () => {
    success = hook!.handleTextInputSubmit('');
  });
  await flush();
  expect(hook!.phase).toBe('edit_fields');

  const editFields = hook!.getActiveItems();
  const baseUrlField = editFields.find((item) => item.kind === 'field' && item.label === 'Base URL') as
    | { kind: 'field'; label: string; detail?: string }
    | undefined;
  expect(baseUrlField).toBeTruthy();
  expect(baseUrlField?.detail).toBe('http://localhost:8000/v1');
  expect(baseUrlField?.detail?.includes('required') ?? false).toBe(false);

  // Save changes
  expect(hook!.selectedIndex).toBe(4); // "Save Changes" should be pre-selected

  await act(async () => {
    hook!.selectItem();
  });
  await flush();

  expect(hook!.phase).toBe('list');
  expect(hook!.errorMessage).toBe(null);

  // Check persisted in settings
  const persisted = settingsService.get('providers');
  expect(Array.isArray(persisted)).toBe(true);
  expect(persisted.length).toBe(1);
  expect(persisted[0].name).toBe('my-custom-provider');
  expect(persisted[0].type).toBe('openai-compatible');
  expect(persisted[0].baseUrl).toBe('http://localhost:8000/v1');

  await act(async () => {
    renderer.unmount();
  });
});

it.sequential('useProviderSelection - goBack returns wizard fields to the correct phase', async () => {
  const customProviders = [
    { name: 'existing-provider', type: 'openai-compatible', baseUrl: 'http://localhost:11434/v1' },
  ];
  const settingsService = createMockSettingsService(customProviders, 'existing-provider');
  let hook: ReturnType<typeof useProviderSelection> | undefined;
  let renderer: any;

  await act(async () => {
    renderer = render(
      React.createElement(
        InputProvider as any,
        {},
        React.createElement(TestComponent, {
          settingsService,
          onHookResult: (h) => {
            hook = h;
          },
        }),
      ),
    );
  });

  await act(async () => {
    hook!.open();
  });
  await flush();

  await act(async () => {
    const active = hook!.getActiveItems();
    const targetIdx = active.findIndex((item) => item.kind === 'provider' && item.id === 'existing-provider');
    let moves = 0;
    for (let i = 0; i < targetIdx; i++) {
      if (!(active[i]!.kind === 'provider' && (active[i] as any).id === 'codex')) {
        moves++;
      }
    }
    for (let i = 0; i < moves; i++) {
      hook!.moveDown();
    }
  });
  await flush();

  // Enter on a custom provider jumps straight to edit_fields.
  await act(async () => {
    hook!.selectItem();
  });
  await flush();

  expect(hook!.phase).toBe('edit_fields');
  expect(hook!.selectedIndex).toBe(0);

  // Enter on the Name field opens the name editor.
  await act(async () => {
    hook!.selectItem();
  });
  await flush();

  expect(hook!.phase).toBe('wizard_name');
  expect(hook!.selectedIndex).toBe(0);

  await act(async () => {
    hook!.goBack();
  });
  await flush();

  expect(hook!.phase).toBe('edit_fields');
  expect(hook!.selectedIndex).toBe(0);

  await act(async () => {
    renderer.unmount();
  });
});

it.sequential('useProviderSelection - confirm discard appears when backing out of a modified wizard', async () => {
  const settingsService = createMockSettingsService([], 'openai');
  let hook: ReturnType<typeof useProviderSelection> | undefined;
  let renderer: any;

  await act(async () => {
    renderer = render(
      React.createElement(
        InputProvider as any,
        {},
        React.createElement(TestComponent, {
          settingsService,
          onHookResult: (h) => {
            hook = h;
          },
        }),
      ),
    );
  });

  await act(async () => {
    hook!.open();
  });
  await flush();

  await act(async () => {
    const active = hook!.getActiveItems();
    const targetIdx = active.findIndex((item) => item.kind === 'add-provider');
    let moves = 0;
    for (let i = 0; i < targetIdx; i++) {
      if (!(active[i]!.kind === 'provider' && (active[i] as any).id === 'codex')) {
        moves++;
      }
    }
    for (let i = 0; i < moves; i++) {
      hook!.moveDown();
    }
  });
  await flush();

  await act(async () => {
    hook!.selectItem();
  });
  await flush();

  expect(hook!.phase).toBe('wizard_name');

  await act(async () => {
    hook!.handleTextInputSubmit('test-provider');
  });
  await flush();

  expect(hook!.phase).toBe('wizard_type');

  await act(async () => {
    hook!.goBack();
  });
  await flush();

  expect(hook!.phase).toBe('confirm_discard');
  expect(hook!.selectedIndex).toBe(1);

  await act(async () => {
    hook!.selectItem();
  });
  await flush();

  expect(hook!.phase).toBe('wizard_type');
  expect(hook!.selectedIndex).toBe(0);

  await act(async () => {
    hook!.goBack();
  });
  await flush();

  expect(hook!.phase).toBe('confirm_discard');

  await act(async () => {
    hook!.moveUp();
  });
  await flush();

  await act(async () => {
    hook!.selectItem();
  });
  await flush();

  expect(hook!.phase).toBe('wizard_name');
  expect(hook!.draft).toBeTruthy();

  await act(async () => {
    renderer.unmount();
  });
});

it.sequential('useProviderSelection - back out of an unmodified wizard returns directly to the list', async () => {
  const settingsService = createMockSettingsService([], 'openai');
  let hook: ReturnType<typeof useProviderSelection> | undefined;
  let renderer: any;

  await act(async () => {
    renderer = render(
      React.createElement(
        InputProvider as any,
        {},
        React.createElement(TestComponent, {
          settingsService,
          onHookResult: (h) => {
            hook = h;
          },
        }),
      ),
    );
  });

  await act(async () => {
    hook!.open();
  });
  await flush();

  await act(async () => {
    const active = hook!.getActiveItems();
    const targetIdx = active.findIndex((item) => item.kind === 'add-provider');
    let moves = 0;
    for (let i = 0; i < targetIdx; i++) {
      if (!(active[i]!.kind === 'provider' && (active[i] as any).id === 'codex')) {
        moves++;
      }
    }
    for (let i = 0; i < moves; i++) {
      hook!.moveDown();
    }
  });
  await flush();

  await act(async () => {
    hook!.selectItem();
  });
  await flush();

  expect(hook!.phase).toBe('wizard_name');

  await act(async () => {
    hook!.goBack();
  });
  await flush();

  expect(hook!.phase).toBe('list');

  await act(async () => {
    renderer.unmount();
  });
});

it.sequential('useProviderSelection - saveDraft rejects duplicate names discovered after editing starts', async () => {
  const settingsService = createMockSettingsService([], 'openai');
  let hook: ReturnType<typeof useProviderSelection> | undefined;
  let renderer: any;

  await act(async () => {
    renderer = render(
      React.createElement(
        InputProvider as any,
        {},
        React.createElement(TestComponent, {
          settingsService,
          onHookResult: (h) => {
            hook = h;
          },
        }),
      ),
    );
  });

  await act(async () => {
    hook!.open();
  });
  await flush();

  await act(async () => {
    const active = hook!.getActiveItems();
    const targetIdx = active.findIndex((item) => item.kind === 'add-provider');
    let moves = 0;
    for (let i = 0; i < targetIdx; i++) {
      if (!(active[i]!.kind === 'provider' && (active[i] as any).id === 'codex')) {
        moves++;
      }
    }
    for (let i = 0; i < moves; i++) {
      hook!.moveDown();
    }
  });
  await flush();

  await act(async () => {
    hook!.selectItem();
  });
  await flush();

  expect(hook!.phase).toBe('wizard_name');

  let success = false;
  await act(async () => {
    success = hook!.handleTextInputSubmit('late-conflict-provider');
  });
  await flush();

  expect(success).toBe(true);

  await act(async () => {
    hook!.selectItem();
  });
  await flush();

  expect(hook!.phase).toBe('wizard_url');
  expect(hook!.draft?.type).toBe('openai-compatible');

  await act(async () => {
    hook!.handleTextInputSubmit('http://localhost:8000/v1');
  });
  await flush();

  await act(async () => {
    hook!.handleTextInputSubmit('');
  });
  await flush();

  settingsService.set('providers', [
    { name: 'late-conflict-provider', type: 'openai-compatible', baseUrl: 'http://localhost:9000/v1' },
  ]);

  await act(async () => {
    hook!.selectItem();
  });
  await flush();

  expect(hook!.phase).toBe('edit_fields');
  expect(hook!.fieldErrors).toEqual({ name: "Provider with name 'late-conflict-provider' already exists." });
  expect(hook!.errorMessage).toBe(null);
  expect(settingsService.get('providers').length).toBe(1);

  await act(async () => {
    renderer.unmount();
  });
});

it.sequential('useProviderSelection - unchanged provider names are allowed when editing', async () => {
  const customProviders = [
    { name: 'existing-provider', type: 'openai-compatible', baseUrl: 'http://localhost:11434/v1' },
  ];
  const settingsService = createMockSettingsService(customProviders, 'existing-provider');
  let hook: ReturnType<typeof useProviderSelection> | undefined;
  let renderer: any;

  await act(async () => {
    renderer = render(
      React.createElement(
        InputProvider as any,
        {},
        React.createElement(TestComponent, {
          settingsService,
          onHookResult: (h) => {
            hook = h;
          },
        }),
      ),
    );
  });

  await act(async () => {
    hook!.open();
  });
  await flush();

  await act(async () => {
    const active = hook!.getActiveItems();
    const targetIdx = active.findIndex((item) => item.kind === 'provider' && item.id === 'existing-provider');
    let moves = 0;
    for (let i = 0; i < targetIdx; i++) {
      if (!(active[i]!.kind === 'provider' && (active[i] as any).id === 'codex')) {
        moves++;
      }
    }
    for (let i = 0; i < moves; i++) {
      hook!.moveDown();
    }
  });
  await flush();

  // Enter on the custom provider goes directly to edit_fields.
  await act(async () => {
    hook!.selectItem();
  });
  await flush();

  // Enter on the Name field opens the name editor.
  await act(async () => {
    hook!.selectItem();
  });
  await flush();

  expect(hook!.phase).toBe('wizard_name');

  let success = false;
  await act(async () => {
    success = hook!.handleTextInputSubmit('existing-provider');
  });
  await flush();

  expect(success).toBe(true);
  expect(hook!.phase).toBe('edit_fields');

  await act(async () => {
    hook!.moveDown();
    hook!.moveDown();
    hook!.moveDown();
    hook!.moveDown();
  });
  await flush();

  expect(hook!.selectedIndex).toBe(4);

  await act(async () => {
    hook!.selectItem();
  });
  await flush();

  expect(hook!.phase).toBe('list');
  expect(hook!.errorMessage).toBe(null);
  expect(settingsService.get('providers').length).toBe(1);
  expect(settingsService.get('providers')[0].name).toBe('existing-provider');

  await act(async () => {
    renderer.unmount();
  });
});

it.sequential('useProviderSelection - scrollOffset updates when navigating and resets on phase change', async () => {
  // Create many mock custom providers to exceed the scroll threshold of 10
  const customProviders = Array.from({ length: 15 }, (_, i) => ({
    name: `custom-provider-${i}`,
    type: 'openai-compatible',
    baseUrl: `http://localhost:1143${i}/v1`,
  }));
  const settingsService = createMockSettingsService(customProviders, 'openai');
  let hook: ReturnType<typeof useProviderSelection> | undefined;
  let renderer: any;

  await act(async () => {
    renderer = render(
      React.createElement(
        InputProvider as any,
        {},
        React.createElement(TestComponent, {
          settingsService,
          onHookResult: (h) => {
            hook = h;
          },
        }),
      ),
    );
  });

  await act(async () => {
    hook!.open();
  });
  await flush();

  expect(hook!.phase).toBe('list');
  expect(hook!.scrollOffset).toBe(0);

  // Move down 10 times to reach index 11 (the 11th active item)
  await act(async () => {
    for (let i = 0; i < 10; i++) {
      hook!.moveDown();
    }
  });
  await flush();

  expect(hook!.selectedIndex).toBe(11);
  expect(hook!.scrollOffset).toBe(2); // was: t.is(hook!.scrollOffset, 2, 'scrollOffset should scroll to 2 when reaching index 11')

  // Move down 1 more time to index 12 (the 12th active item)
  await act(async () => {
    hook!.moveDown();
  });
  await flush();

  expect(hook!.selectedIndex).toBe(12);
  expect(hook!.scrollOffset).toBe(3); // was: t.is(hook!.scrollOffset, 3, 'scrollOffset should scroll to 3 when reaching index 12')

  // Move up to index 0 (scrollOffset should sync back)
  await act(async () => {
    for (let i = 0; i < 11; i++) {
      hook!.moveUp();
    }
  });
  await flush();

  expect(hook!.selectedIndex).toBe(0);
  expect(hook!.scrollOffset).toBe(0); // was: t.is(hook!.scrollOffset, 0, 'scrollOffset should return to 0 when moving back to the top')

  // Transition to wizard_name phase to verify scrollOffset resets
  // Let's select "Add Custom Provider" which is at the end of the list
  await act(async () => {
    const active = hook!.getActiveItems();
    const targetIdx = active.findIndex((item) => item.kind === 'add-provider');
    let moves = 0;
    for (let i = 0; i < targetIdx; i++) {
      if (!(active[i]!.kind === 'provider' && (active[i] as any).id === 'codex')) {
        moves++;
      }
    }
    for (let i = 0; i < moves; i++) {
      hook!.moveDown();
    }
  });
  await flush();

  expect(hook!.selectedIndex).toBe(hook!.items.length);
  expect(hook!.scrollOffset > 0).toBe(true);

  await act(async () => {
    hook!.selectItem();
  });
  await flush();

  expect(hook!.phase).toBe('wizard_name');
  expect(hook!.scrollOffset, 'scrollOffset should reset to 0 when phase changes to wizard_name').toBe(0);

  await act(async () => {
    renderer.unmount();
  });
});

it.sequential(
  'useProviderSelection - editing a field from edit_fields populates input with current value',
  async () => {
    const customProviders = [
      { name: 'my-provider', type: 'openai-compatible', baseUrl: 'http://example.com/v1', apiKey: 'secret-key' },
    ];
    const settingsService = createMockSettingsService(customProviders, 'openai');
    let hook: ReturnType<typeof useProviderSelection> | undefined;
    let inputVal = '';
    let renderer: any;

    await act(async () => {
      renderer = render(
        React.createElement(
          InputProvider as any,
          {},
          React.createElement(TestComponent, {
            settingsService,
            onHookResult: (h) => {
              hook = h;
            },
            onInputValue: (v: string) => {
              inputVal = v;
            },
          }),
        ),
      );
    });

    await act(async () => {
      hook!.open();
    });
    await flush();

    // Navigate to the custom provider and select it to enter edit_fields
    await act(async () => {
      const active = hook!.getActiveItems();
      const targetIdx = active.findIndex((item) => item.kind === 'provider' && item.id === 'my-provider');
      let moves = 0;
      for (let i = 0; i < targetIdx; i++) {
        if (!(active[i]!.kind === 'provider' && (active[i] as any).id === 'codex')) {
          moves++;
        }
      }
      for (let i = 0; i < moves; i++) {
        hook!.moveDown();
      }
    });
    await flush();

    await act(async () => {
      hook!.selectItem();
    });
    await flush();

    expect(hook!.phase).toBe('edit_fields');
    expect(hook!.draft?.name).toBe('my-provider');

    // Test editing Name field (index 0)
    await act(async () => {
      hook!.selectItem(); // index 0 = Name
    });
    await flush();

    expect(hook!.phase).toBe('wizard_name');
    expect(inputVal, 'input should be populated with current name').toBe('my-provider');

    // Go back
    await act(async () => {
      hook!.goBack();
    });
    await flush();
    expect(hook!.phase).toBe('edit_fields');

    // Test editing Base URL field (index 2)
    await act(async () => {
      hook!.moveDown();
      hook!.moveDown();
    });
    await flush();

    await act(async () => {
      hook!.selectItem(); // index 2 = Base URL
    });
    await flush();

    expect(hook!.phase).toBe('wizard_url');
    expect(inputVal, 'input should be populated with current baseUrl').toBe('http://example.com/v1');

    // Go back
    await act(async () => {
      hook!.goBack();
    });
    await flush();
    expect(hook!.phase).toBe('edit_fields');

    // Test editing API Key field (index 3)
    await act(async () => {
      hook!.moveDown();
    });
    await flush();

    await act(async () => {
      hook!.selectItem(); // index 3 = API Key
    });
    await flush();

    expect(hook!.phase).toBe('wizard_key');
    expect(inputVal, 'input should be populated with current apiKey').toBe('secret-key');

    await act(async () => {
      renderer.unmount();
    });
  },
);
