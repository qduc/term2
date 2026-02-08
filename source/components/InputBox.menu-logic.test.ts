import test from 'ava';

// Copy of the pure function for testing (in real code, export from InputBox.tsx)
const STOP_CHAR_REGEX = /[\s,;:()[\]{}<>]/;
const SETTINGS_TRIGGER = '/settings ';
const MODEL_TRIGGER = '/settings agent.model ';

type ActiveMenu =
  | { type: 'none' }
  | { type: 'slash' }
  | { type: 'settings'; query: string; startIndex: number }
  | { type: 'model'; query: string; startIndex: number }
  | { type: 'path'; trigger: { start: number; query: string } };

const whitespaceRegex = /\s/;

const findPathTrigger = (text: string, cursor: number, stopChars: RegExp): { start: number; query: string } | null => {
  if (cursor <= 0 || cursor > text.length) {
    return null;
  }

  for (let index = cursor - 1; index >= 0; index -= 1) {
    const char = text[index];
    if (char === '@') {
      const query = text.slice(index + 1, cursor);
      if (whitespaceRegex.test(query)) {
        return null;
      }

      return { start: index, query };
    }

    if (stopChars.test(char)) {
      break;
    }
  }

  return null;
};

function determineActiveMenu(value: string, cursorOffset: number): ActiveMenu {
  // Priority 0: Model selection (more specific than settings)
  if (value.startsWith(MODEL_TRIGGER) && cursorOffset >= MODEL_TRIGGER.length) {
    return {
      type: 'model',
      query: value.slice(MODEL_TRIGGER.length, cursorOffset),
      startIndex: MODEL_TRIGGER.length,
    };
  }

  // Priority 1: Settings menu (most specific)
  if (value.startsWith(SETTINGS_TRIGGER)) {
    return {
      type: 'settings',
      query: value.slice(SETTINGS_TRIGGER.length),
      startIndex: SETTINGS_TRIGGER.length,
    };
  }

  // Priority 2: Slash menu (less specific)
  if (value.startsWith('/')) {
    return { type: 'slash' };
  }

  // Priority 3: Path menu (fallback)
  const pathTrigger = findPathTrigger(value, cursorOffset, STOP_CHAR_REGEX);
  if (pathTrigger) {
    return { type: 'path', trigger: pathTrigger };
  }

  return { type: 'none' };
}

// Table-driven tests
test('determineActiveMenu - priority 1: settings menu', (t) => {
  const cases: Array<{ input: string; cursor: number; expected: ActiveMenu }> = [
    {
      input: '/settings ',
      cursor: 10,
      expected: { type: 'settings', query: '', startIndex: 10 },
    },
    {
      input: '/settings agent.model',
      cursor: 21,
      expected: {
        type: 'settings',
        query: 'agent.model',
        startIndex: 10,
      },
    },
    {
      input: '/settings ag',
      cursor: 12,
      expected: { type: 'settings', query: 'ag', startIndex: 10 },
    },
    {
      input: '/settings agent.model value',
      cursor: '/settings agent.model value'.length,
      expected: {
        type: 'model',
        query: 'value',
        startIndex: MODEL_TRIGGER.length,
      },
    },
  ];

  for (const { input, cursor, expected } of cases) {
    t.deepEqual(determineActiveMenu(input, cursor), expected, `Failed for input: "${input}"`);
  }
});

test('determineActiveMenu - priority 2: slash menu', (t) => {
  const cases: Array<{ input: string; cursor: number; expected: ActiveMenu }> = [
    { input: '/', cursor: 1, expected: { type: 'slash' } },
    { input: '/mod', cursor: 4, expected: { type: 'slash' } },
    { input: '/clear', cursor: 6, expected: { type: 'slash' } },
  ];

  for (const { input, cursor, expected } of cases) {
    t.deepEqual(determineActiveMenu(input, cursor), expected, `Failed for input: "${input}"`);
  }
});

test('determineActiveMenu - priority 3: path menu', (t) => {
  const cases: Array<{ input: string; cursor: number; expected: ActiveMenu }> = [
    {
      input: '@',
      cursor: 1,
      expected: { type: 'path', trigger: { start: 0, query: '' } },
    },
    {
      input: '@src',
      cursor: 4,
      expected: { type: 'path', trigger: { start: 0, query: 'src' } },
    },
    {
      input: 'check @src/app',
      cursor: 14,
      expected: { type: 'path', trigger: { start: 6, query: 'src/app' } },
    },
  ];

  for (const { input, cursor, expected } of cases) {
    t.deepEqual(determineActiveMenu(input, cursor), expected, `Failed for input: "${input}"`);
  }
});

test('determineActiveMenu - no menu active', (t) => {
  const cases: Array<{ input: string; cursor: number; expected: ActiveMenu }> = [
    { input: '', cursor: 0, expected: { type: 'none' } },
    { input: 'hello world', cursor: 11, expected: { type: 'none' } },
    { input: 'test', cursor: 4, expected: { type: 'none' } },
  ];

  for (const { input, cursor, expected } of cases) {
    t.deepEqual(determineActiveMenu(input, cursor), expected, `Failed for input: "${input}"`);
  }
});

test('determineActiveMenu - priority enforcement', (t) => {
  // Settings takes priority over slash
  t.deepEqual(determineActiveMenu('/settings ', 10), {
    type: 'settings',
    query: '',
    startIndex: 10,
  });

  // Model takes priority over settings when full trigger present
  t.deepEqual(determineActiveMenu('/settings agent.model ', MODEL_TRIGGER.length), {
    type: 'model',
    query: '',
    startIndex: MODEL_TRIGGER.length,
  });

  // Slash takes priority over path (edge case: /@ would be slash, not path)
  t.deepEqual(determineActiveMenu('/@test', 6), {
    type: 'slash',
  });
});
