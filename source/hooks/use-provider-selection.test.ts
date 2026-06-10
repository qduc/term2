// @ts-ignore
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import test from 'ava';
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

test.serial('useProviderSelection - lists registered and custom providers on open', async (t) => {
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

  t.true(hook !== undefined);

  await act(async () => {
    hook!.open();
  });
  await flush();

  t.is(hook!.phase, 'list');
  const items = hook!.items;
  t.true(items.some((item) => item.id === 'openai' && !item.isCustom && item.isActive));
  t.true(items.some((item) => item.id === 'custom-ollama' && item.isCustom && !item.isActive));

  await act(async () => {
    renderer.unmount();
  });
});

test.serial('useProviderSelection - selecting a custom provider opens edit_fields directly', async (t) => {
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

  t.is(hook!.phase, 'edit_fields');
  t.is(hook!.selectedIndex, 0);
  t.is(hook!.draft?.name, 'custom-ollama');
  t.is(hook!.draft?.baseUrl, 'http://localhost:11434/v1');

  await act(async () => {
    renderer.unmount();
  });
});

test.serial(
  'useProviderSelection - selecting a built-in provider (except Codex) enters editing flow; Codex is a no-op',
  async (t) => {
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
    t.true(codexIdx !== -1);

    // Let's verify that navigating moveDown starting from index 0 skips codexIdx
    t.is(hook!.selectedIndex, 0); // Start at OpenAI

    // Move down a fixed number of times. We should never land on codexIdx!
    const visitedIndices = new Set<number>();
    await act(async () => {
      for (let i = 0; i < active.length; i++) {
        visitedIndices.add(hook!.selectedIndex);
        hook!.moveDown();
      }
    });
    await flush();

    t.false(visitedIndices.has(codexIdx), 'Keyboard navigation should skip Codex');

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
    t.is(hook!.phase, 'edit_fields');
    t.is(hook!.selectedIndex, 2); // API Key is selected
    t.is(hook!.draft?.name, 'OpenAI');

    // Verify we can edit API Key and save it
    await act(async () => {
      hook!.selectItem(); // select API Key at index 2
    });
    await flush();
    t.is(hook!.phase, 'wizard_key');

    await act(async () => {
      hook!.handleTextInputSubmit('sk-mock-openai-key');
    });
    await flush();
    t.is(hook!.phase, 'edit_fields');
    t.is(hook!.selectedIndex, 2); // Selected row is API Key row

    await act(async () => {
      hook!.moveDown(); // Move to "Save Changes" at index 3
    });
    await flush();
    t.is(hook!.selectedIndex, 3);

    await act(async () => {
      hook!.selectItem(); // Save Changes
    });
    await flush();

    t.is(hook!.phase, 'list');
    t.is(settingsService.get('agent.openai.apiKey'), 'sk-mock-openai-key');

    await act(async () => {
      renderer.unmount();
    });
  },
);

test.serial('useProviderSelection - requestDelete on a custom provider opens confirm_delete', async (t) => {
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

  t.is(hook!.phase, 'confirm_delete');
  // Default cursor should be on "No, keep it" for safety.
  t.is(hook!.selectedIndex, 1);

  // Confirming "No, keep it" returns to the list.
  await act(async () => {
    hook!.selectItem();
  });
  await flush();
  t.is(hook!.phase, 'list');
  t.is(settingsService.get('providers').length, 1);

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
  t.is(hook!.phase, 'confirm_delete');

  await act(async () => {
    hook!.moveUp(); // move from default "No" to "Yes"
  });
  await flush();
  t.is(hook!.selectedIndex, 0);

  await act(async () => {
    hook!.selectItem();
  });
  await flush();
  t.is(hook!.phase, 'list');
  t.is(settingsService.get('providers').length, 0);
  t.is(settingsService.get('agent.provider'), 'openai');

  await act(async () => {
    renderer.unmount();
  });
});

test.serial('useProviderSelection - requestDelete on a built-in is a no-op', async (t) => {
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

  t.is(hook!.phase, 'list');

  await act(async () => {
    renderer.unmount();
  });
});

test.serial('useProviderSelection - add provider wizard flow and validation', async (t) => {
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

  t.is(hook!.phase, 'wizard_name');

  // Submit valid name (validation is tested in provider-service.test.ts)
  let success = false;
  await act(async () => {
    success = hook!.handleTextInputSubmit('my-custom-provider');
  });
  await flush();
  t.true(success);
  t.is(hook!.phase, 'wizard_type');
  t.is(hook!.draft?.name, 'my-custom-provider');

  // Select first type (openai-compatible)
  await act(async () => {
    hook!.selectItem();
  });
  await flush();
  t.is(hook!.phase, 'wizard_url');
  t.is(hook!.draft?.type, 'openai-compatible');

  // Submit valid URL (URL validation is tested in provider-service.test.ts)
  await act(async () => {
    success = hook!.handleTextInputSubmit('http://localhost:8000/v1');
  });
  await flush();
  t.true(success);
  t.is(hook!.phase, 'wizard_key');
  t.is(hook!.draft?.baseUrl, 'http://localhost:8000/v1');

  // Submit empty API Key (success)
  await act(async () => {
    success = hook!.handleTextInputSubmit('');
  });
  await flush();
  t.is(hook!.phase, 'edit_fields');

  const editFields = hook!.getActiveItems();
  const baseUrlField = editFields.find((item) => item.kind === 'field' && item.label === 'Base URL') as
    | { kind: 'field'; label: string; detail?: string }
    | undefined;
  t.truthy(baseUrlField);
  t.is(baseUrlField?.detail, 'http://localhost:8000/v1');
  t.false(baseUrlField?.detail?.includes('required') ?? false);

  // Save changes
  t.is(hook!.selectedIndex, 4); // "Save Changes" should be pre-selected

  await act(async () => {
    hook!.selectItem();
  });
  await flush();

  t.is(hook!.phase, 'list');
  t.is(hook!.errorMessage, null);

  // Check persisted in settings
  const persisted = settingsService.get('providers');
  t.true(Array.isArray(persisted));
  t.is(persisted.length, 1);
  t.is(persisted[0].name, 'my-custom-provider');
  t.is(persisted[0].type, 'openai-compatible');
  t.is(persisted[0].baseUrl, 'http://localhost:8000/v1');

  await act(async () => {
    renderer.unmount();
  });
});

test.serial('useProviderSelection - goBack returns wizard fields to the correct phase', async (t) => {
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

  t.is(hook!.phase, 'edit_fields');
  t.is(hook!.selectedIndex, 0);

  // Enter on the Name field opens the name editor.
  await act(async () => {
    hook!.selectItem();
  });
  await flush();

  t.is(hook!.phase, 'wizard_name');
  t.is(hook!.selectedIndex, 0);

  await act(async () => {
    hook!.goBack();
  });
  await flush();

  t.is(hook!.phase, 'edit_fields');
  t.is(hook!.selectedIndex, 0);

  await act(async () => {
    renderer.unmount();
  });
});

test.serial('useProviderSelection - confirm discard appears when backing out of a modified wizard', async (t) => {
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

  t.is(hook!.phase, 'wizard_name');

  await act(async () => {
    hook!.handleTextInputSubmit('test-provider');
  });
  await flush();

  t.is(hook!.phase, 'wizard_type');

  await act(async () => {
    hook!.goBack();
  });
  await flush();

  t.is(hook!.phase, 'confirm_discard');
  t.is(hook!.selectedIndex, 1);

  await act(async () => {
    hook!.selectItem();
  });
  await flush();

  t.is(hook!.phase, 'wizard_type');
  t.is(hook!.selectedIndex, 0);

  await act(async () => {
    hook!.goBack();
  });
  await flush();

  t.is(hook!.phase, 'confirm_discard');

  await act(async () => {
    hook!.moveUp();
  });
  await flush();

  await act(async () => {
    hook!.selectItem();
  });
  await flush();

  t.is(hook!.phase, 'wizard_name');
  t.truthy(hook!.draft);

  await act(async () => {
    renderer.unmount();
  });
});

test.serial('useProviderSelection - back out of an unmodified wizard returns directly to the list', async (t) => {
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

  t.is(hook!.phase, 'wizard_name');

  await act(async () => {
    hook!.goBack();
  });
  await flush();

  t.is(hook!.phase, 'list');

  await act(async () => {
    renderer.unmount();
  });
});

test.serial('useProviderSelection - saveDraft rejects duplicate names discovered after editing starts', async (t) => {
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

  t.is(hook!.phase, 'wizard_name');

  let success = false;
  await act(async () => {
    success = hook!.handleTextInputSubmit('late-conflict-provider');
  });
  await flush();

  t.true(success);

  await act(async () => {
    hook!.selectItem();
  });
  await flush();

  t.is(hook!.phase, 'wizard_url');
  t.is(hook!.draft?.type, 'openai-compatible');

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

  t.is(hook!.phase, 'edit_fields');
  t.deepEqual(hook!.fieldErrors, { name: "Provider with name 'late-conflict-provider' already exists." });
  t.is(hook!.errorMessage, null);
  t.is(settingsService.get('providers').length, 1);

  await act(async () => {
    renderer.unmount();
  });
});

test.serial('useProviderSelection - unchanged provider names are allowed when editing', async (t) => {
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

  t.is(hook!.phase, 'wizard_name');

  let success = false;
  await act(async () => {
    success = hook!.handleTextInputSubmit('existing-provider');
  });
  await flush();

  t.true(success);
  t.is(hook!.phase, 'edit_fields');

  await act(async () => {
    hook!.moveDown();
    hook!.moveDown();
    hook!.moveDown();
    hook!.moveDown();
  });
  await flush();

  t.is(hook!.selectedIndex, 4);

  await act(async () => {
    hook!.selectItem();
  });
  await flush();

  t.is(hook!.phase, 'list');
  t.is(hook!.errorMessage, null);
  t.is(settingsService.get('providers').length, 1);
  t.is(settingsService.get('providers')[0].name, 'existing-provider');

  await act(async () => {
    renderer.unmount();
  });
});

test.serial('useProviderSelection - scrollOffset updates when navigating and resets on phase change', async (t) => {
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

  t.is(hook!.phase, 'list');
  t.is(hook!.scrollOffset, 0);

  // Move down 10 times to reach index 11 (the 11th active item)
  await act(async () => {
    for (let i = 0; i < 10; i++) {
      hook!.moveDown();
    }
  });
  await flush();

  t.is(hook!.selectedIndex, 11);
  t.is(hook!.scrollOffset, 2, 'scrollOffset should scroll to 2 when reaching index 11');

  // Move down 1 more time to index 12 (the 12th active item)
  await act(async () => {
    hook!.moveDown();
  });
  await flush();

  t.is(hook!.selectedIndex, 12);
  t.is(hook!.scrollOffset, 3, 'scrollOffset should scroll to 3 when reaching index 12');

  // Move up to index 0 (scrollOffset should sync back)
  await act(async () => {
    for (let i = 0; i < 11; i++) {
      hook!.moveUp();
    }
  });
  await flush();

  t.is(hook!.selectedIndex, 0);
  t.is(hook!.scrollOffset, 0, 'scrollOffset should return to 0 when moving back to the top');

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

  t.is(hook!.selectedIndex, hook!.items.length);
  t.true(hook!.scrollOffset > 0, 'scrollOffset should be non-zero near the end of the long list');

  await act(async () => {
    hook!.selectItem();
  });
  await flush();

  t.is(hook!.phase, 'wizard_name');
  t.is(hook!.scrollOffset, 0, 'scrollOffset should reset to 0 when phase changes to wizard_name');

  await act(async () => {
    renderer.unmount();
  });
});

test.serial('useProviderSelection - editing a field from edit_fields populates input with current value', async (t) => {
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

  t.is(hook!.phase, 'edit_fields');
  t.is(hook!.draft?.name, 'my-provider');

  // Test editing Name field (index 0)
  await act(async () => {
    hook!.selectItem(); // index 0 = Name
  });
  await flush();

  t.is(hook!.phase, 'wizard_name');
  t.is(inputVal, 'my-provider', 'input should be populated with current name');

  // Go back
  await act(async () => {
    hook!.goBack();
  });
  await flush();
  t.is(hook!.phase, 'edit_fields');

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

  t.is(hook!.phase, 'wizard_url');
  t.is(inputVal, 'http://example.com/v1', 'input should be populated with current baseUrl');

  // Go back
  await act(async () => {
    hook!.goBack();
  });
  await flush();
  t.is(hook!.phase, 'edit_fields');

  // Test editing API Key field (index 3)
  await act(async () => {
    hook!.moveDown();
  });
  await flush();

  await act(async () => {
    hook!.selectItem(); // index 3 = API Key
  });
  await flush();

  t.is(hook!.phase, 'wizard_key');
  t.is(inputVal, 'secret-key', 'input should be populated with current apiKey');

  await act(async () => {
    renderer.unmount();
  });
});
