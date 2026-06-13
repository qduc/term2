import test from 'ava';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { createSearchReplaceToolDefinition } from './search-replace.js';
import { createMockSettingsService } from '../../services/settings/settings-service.mock.js';
import type { ILoggingService } from '../../services/service-interfaces.js';

// Helper to create a temp dir and change cwd to it
async function withTempDir(run: (dir: string) => Promise<void>) {
  const originalCwd = process.cwd;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'term2-search-replace-'));

  // Mock process.cwd
  process.cwd = () => tempDir;

  try {
    await run(tempDir);
  } finally {
    process.cwd = originalCwd;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

const mockLoggingService: ILoggingService = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  security: () => {},
  setCorrelationId: () => {},
  getCorrelationId: () => undefined,
  clearCorrelationId: () => {},
};

function createTool(
  settingsService = createMockSettingsService(),
  editHealing?: typeof import('./edit-healing.js').healSearchReplaceParams,
) {
  return createSearchReplaceToolDefinition({
    loggingService: mockLoggingService,
    settingsService,
    ...(editHealing ? { editHealing } : {}),
  });
}

test.serial('needsApproval auto-approves creation when search_content is empty and file is missing', async (t) => {
  await withTempDir(async () => {
    const tool = createTool(createMockSettingsService());
    const filePath = 'new-file.txt';

    const result = await tool.needsApproval({
      path: filePath,
      replacements: [
        {
          search_content: '',
          replace_content: 'initial content',
        },
      ],
    });

    t.false(result);
  });
});

test.serial('needsApproval auto-approves a unique exact match', async (t) => {
  await withTempDir(async (dir) => {
    const tool = createTool(createMockSettingsService());
    const filePath = 'sample.txt';
    const absPath = path.join(dir, filePath);
    await fs.writeFile(absPath, 'hello world');

    const result = await tool.needsApproval({
      path: filePath,
      replacements: [
        {
          search_content: 'hello',
          replace_content: 'hi',
        },
      ],
    });

    t.false(result);
  });
});

test.serial('needsApproval auto-approves when multiple exact matches are found', async (t) => {
  await withTempDir(async (dir) => {
    const tool = createTool(createMockSettingsService());
    const filePath = 'sample.txt';
    const absPath = path.join(dir, filePath);
    await fs.writeFile(absPath, 'hello world hello');

    const result = await tool.needsApproval({
      path: filePath,
      replacements: [
        {
          search_content: 'hello',
          replace_content: 'hi',
        },
      ],
    });

    t.false(result);
  });
});

test.serial('execute replaces only a unique exact match', async (t) => {
  await withTempDir(async (dir) => {
    const tool = createTool();
    const filePath = 'content.txt';
    const absPath = path.join(dir, filePath);
    await fs.writeFile(absPath, 'target before unique after');

    const result = await tool.execute({
      path: filePath,
      replacements: [
        {
          search_content: 'target',
          replace_content: 'done',
        },
      ],
    });

    const parsed = JSON.parse(result);
    t.true(parsed.output[0].success);

    const updated = await fs.readFile(absPath, 'utf8');
    t.is(updated, 'done before unique after');
  });
});

test.serial('execute fails when multiple exact matches are found', async (t) => {
  await withTempDir(async (dir) => {
    const tool = createTool();
    const filePath = 'content.txt';
    const absPath = path.join(dir, filePath);
    await fs.writeFile(absPath, 'foo foo foo');

    const result = await tool.execute({
      path: filePath,
      replacements: [
        {
          search_content: 'foo',
          replace_content: 'bar',
        },
      ],
    });

    const parsed = JSON.parse(result);
    t.false(parsed.output[0].success);
    t.regex(parsed.output[0].error, /Found 3 exact matches/);

    const updated = await fs.readFile(absPath, 'utf8');
    t.is(updated, 'foo foo foo');
  });
});

test.serial('execute performs relaxed match replacement when exact match is not found', async (t) => {
  await withTempDir(async (dir) => {
    const tool = createTool();
    const filePath = 'content.txt';
    const absPath = path.join(dir, filePath);
    await fs.writeFile(absPath, '    line one\n\tline two\nremainder');

    const result = await tool.execute({
      path: filePath,
      replacements: [
        {
          search_content: 'line one\nline two',
          replace_content: 'new block\n',
        },
      ],
    });

    const parsed = JSON.parse(result);
    t.true(parsed.output[0].success);

    const updated = await fs.readFile(absPath, 'utf8');
    t.is(updated, 'new block\nremainder');
  });
});

test.serial('execute fails when multiple relaxed matches are found', async (t) => {
  await withTempDir(async (dir) => {
    const tool = createTool();
    const filePath = 'content.txt';
    const absPath = path.join(dir, filePath);
    await fs.writeFile(absPath, '  foo  \n\tbar\n---\n  foo  \n\tbar\n');

    const result = await tool.execute({
      path: filePath,
      replacements: [
        {
          search_content: 'foo\nbar',
          replace_content: 'replacement',
        },
      ],
    });

    const parsed = JSON.parse(result);
    t.false(parsed.output[0].success);
    t.true(
      parsed.output[0].error.includes('relaxed matches') || parsed.output[0].error.includes('Found 2 relaxed matches'),
    );

    const unchanged = await fs.readFile(absPath, 'utf8');
    t.is(unchanged, '  foo  \n\tbar\n---\n  foo  \n\tbar\n');
  });
});

test.serial('execute creates a new file when search_content is empty and file is missing', async (t) => {
  await withTempDir(async (dir) => {
    const tool = createTool();
    const filePath = 'missing.txt';
    const absPath = path.join(dir, filePath);

    const result = await tool.execute({
      path: filePath,
      replacements: [
        {
          search_content: '',
          replace_content: 'new content',
        },
      ],
    });

    const parsed = JSON.parse(result);
    t.true(parsed.output[0].success);

    const createdContent = await fs.readFile(absPath, 'utf8');
    t.is(createdContent, 'new content');
  });
});

test.serial('execute preserves parallel edits to different regions of the same file', async (t) => {
  await withTempDir(async (dir) => {
    const tool = createTool(createMockSettingsService({ 'tools.enableEditHealing': false }));
    const filePath = 'parallel.txt';
    const absPath = path.join(dir, filePath);
    const tokens = Array.from({ length: 20 }, (_, index) => `token_${String(index).padStart(2, '0')}`);
    await fs.writeFile(absPath, tokens.join('\n'));

    const results = await Promise.all(
      tokens.map((token, index) =>
        tool.execute({
          path: filePath,
          replacements: [
            {
              search_content: token,
              replace_content: `done_${index}`,
            },
          ],
        }),
      ),
    );

    for (const result of results) {
      const parsed = JSON.parse(result);
      t.true(parsed.output[0].success);
    }

    const updated = await fs.readFile(absPath, 'utf8');
    t.deepEqual(
      updated.split('\n'),
      tokens.map((_, index) => `done_${index}`),
    );
  });
});

test.serial('execute applies batched replacements to one file with a single result per edit', async (t) => {
  await withTempDir(async (dir) => {
    const tool = createTool(createMockSettingsService({ 'tools.enableEditHealing': false }));
    const filePath = 'batch.txt';
    const absPath = path.join(dir, filePath);
    await fs.writeFile(absPath, 'alpha\nbeta\ngamma\n');

    const result = await tool.execute({
      path: filePath,
      replacements: [
        {
          search_content: 'alpha',
          replace_content: 'ALPHA',
        },
        {
          search_content: 'gamma',
          replace_content: 'GAMMA',
        },
      ],
    });

    const parsed = JSON.parse(result);
    t.true(parsed.output.every((item: { success: boolean }) => item.success));
    t.deepEqual(
      parsed.output.map((item: { path: string }) => item.path),
      [filePath, filePath],
    );

    const updated = await fs.readFile(absPath, 'utf8');
    t.is(updated, 'ALPHA\nbeta\nGAMMA\n');
  });
});

test.serial('execute keeps successful batched replacements when another replacement fails', async (t) => {
  await withTempDir(async (dir) => {
    const tool = createTool(createMockSettingsService({ 'tools.enableEditHealing': false }));
    const filePath = 'batch-failure.txt';
    const absPath = path.join(dir, filePath);
    const originalContent = 'alpha\nbeta\ngamma\n';
    await fs.writeFile(absPath, originalContent);

    const result = await tool.execute({
      path: filePath,
      replacements: [
        {
          search_content: 'alpha',
          replace_content: 'ALPHA',
        },
        {
          search_content: 'missing',
          replace_content: 'MISSING',
        },
        {
          search_content: 'gamma',
          replace_content: 'GAMMA',
        },
      ],
    });

    const parsed = JSON.parse(result);
    t.true(parsed.output[0].success);
    t.false(parsed.output[1].success);
    t.true(parsed.output[2].success);

    const updated = await fs.readFile(absPath, 'utf8');
    t.is(updated, 'ALPHA\nbeta\nGAMMA\n');
  });
});

test.serial('execute reports failure when search string is not found', async (t) => {
  await withTempDir(async (dir) => {
    const tool = createTool(createMockSettingsService({ 'tools.enableEditHealing': false }));
    const filePath = 'content.txt';
    const absPath = path.join(dir, filePath);
    const originalContent = 'hello world';
    await fs.writeFile(absPath, originalContent);

    const result = await tool.execute({
      path: filePath,
      replacements: [
        {
          search_content: 'nonexistent',
          replace_content: 'replacement',
        },
      ],
    });

    const parsed = JSON.parse(result);
    t.false(parsed.output[0].success);

    const unchanged = await fs.readFile(absPath, 'utf8');
    t.is(unchanged, originalContent);
  });
});

test.serial('execute heals search content when no match is found', async (t) => {
  await withTempDir(async (dir) => {
    const filePath = 'content.txt';
    const absPath = path.join(dir, filePath);
    await fs.writeFile(absPath, 'const foo = 1;\n');

    const tool = createTool(createMockSettingsService({ 'tools.enableEditHealing': true }), async (params) => ({
      params: {
        ...params,
        search_content: 'const foo = 1;\n',
      },
      wasModified: true,
      confidence: 0.9,
    }));

    const result = await tool.execute({
      path: filePath,
      replacements: [
        {
          search_content: 'const foo = 2;\n',
          replace_content: 'const foo = 3;\n',
        },
      ],
    });

    const parsed = JSON.parse(result);
    t.true(parsed.output[0].success);
    t.true(parsed.output[0].message.includes('auto healing'));

    const updated = await fs.readFile(absPath, 'utf8');
    t.is(updated, 'const foo = 3;\n');
  });
});

test.serial('execute includes auto-healing failure reason when healing does not find a match', async (t) => {
  await withTempDir(async (dir) => {
    const filePath = 'content.txt';
    const absPath = path.join(dir, filePath);
    await fs.writeFile(absPath, 'const foo = 1;\n');

    const tool = createTool(createMockSettingsService({ 'tools.enableEditHealing': true }), async (params) => ({
      params,
      wasModified: false,
      confidence: 0,
      failureReason: 'model returned NO_MATCH',
    }));

    const result = await tool.execute({
      path: filePath,
      replacements: [
        {
          search_content: 'const foo = 2;\n',
          replace_content: 'const foo = 3;\n',
        },
      ],
    });

    const parsed = JSON.parse(result);
    t.false(parsed.output[0].success);
    t.is(parsed.output[0].healing_failure_reason, 'model returned NO_MATCH');
    t.true(parsed.output[0].error.includes('model returned NO_MATCH'));
  });
});

test.serial('execute treats special regex characters literally', async (t) => {
  await withTempDir(async (dir) => {
    const tool = createTool();
    const filePath = 'code.js';
    const absPath = path.join(dir, filePath);
    const originalContent = 'function test() { return [1, 2, 3]; }';
    await fs.writeFile(absPath, originalContent);

    const result = await tool.execute({
      path: filePath,
      replacements: [
        {
          search_content: '[1, 2, 3]',
          replace_content: '[4, 5, 6]',
        },
      ],
    });

    const parsed = JSON.parse(result);
    t.true(parsed.output[0].success);

    const updated = await fs.readFile(absPath, 'utf8');
    t.is(updated, 'function test() { return [4, 5, 6]; }');
  });
});

test.serial('execute deletes content when replacement is empty string', async (t) => {
  await withTempDir(async (dir) => {
    const tool = createTool();
    const filePath = 'sample.txt';
    const absPath = path.join(dir, filePath);
    await fs.writeFile(absPath, 'before DELETE_ME after');

    const result = await tool.execute({
      path: filePath,
      replacements: [
        {
          search_content: 'DELETE_ME ',
          replace_content: '',
        },
      ],
    });

    const parsed = JSON.parse(result);
    t.true(parsed.output[0].success);

    const updated = await fs.readFile(absPath, 'utf8');
    t.is(updated, 'before after');
  });
});

test.serial('execute performs exact multi-line match without whitespace normalization', async (t) => {
  await withTempDir(async (dir) => {
    const tool = createTool();
    const filePath = 'exact.txt';
    const absPath = path.join(dir, filePath);
    await fs.writeFile(absPath, 'line one\nline two\nline three');

    const result = await tool.execute({
      path: filePath,
      replacements: [
        {
          search_content: 'line one\nline two',
          replace_content: 'new content',
        },
      ],
    });

    const parsed = JSON.parse(result);
    t.true(parsed.output[0].success);

    const updated = await fs.readFile(absPath, 'utf8');
    t.is(updated, 'new content\nline three');
  });
});

test.serial('execute handles leading/trailing whitespace differences in relaxed mode', async (t) => {
  await withTempDir(async (dir) => {
    const tool = createTool();
    const filePath = 'whitespace.txt';
    const absPath = path.join(dir, filePath);
    await fs.writeFile(absPath, '  foo  \nbar');

    const result = await tool.execute({
      path: filePath,
      replacements: [
        {
          search_content: 'foo\nbar',
          replace_content: 'replaced',
        },
      ],
    });

    const parsed = JSON.parse(result);
    t.true(parsed.output[0].success);

    const updated = await fs.readFile(absPath, 'utf8');
    t.is(updated, 'replaced');
  });
});

test.serial('execute performs normalized whitespace match across line breaks', async (t) => {
  await withTempDir(async (dir) => {
    const tool = createTool();
    const filePath = 'normalized.txt';
    const absPath = path.join(dir, filePath);
    await fs.writeFile(absPath, 'const foo = 1;\nconst bar = 2;\nconst baz = 3;\n');

    const result = await tool.execute({
      path: filePath,
      replacements: [
        {
          search_content: 'const foo = 1; const bar = 2;',
          replace_content: 'const foo = 1;\nconst bar = 42;',
        },
      ],
    });

    const parsed = JSON.parse(result);
    t.true(parsed.output[0].success);

    const updated = await fs.readFile(absPath, 'utf8');
    t.is(updated, 'const foo = 1;\nconst bar = 42;\nconst baz = 3;\n');
  });
});

test.serial('execute matches escaped newline sequences in search content', async (t) => {
  await withTempDir(async (dir) => {
    const tool = createTool(createMockSettingsService({ 'tools.enableEditHealing': false }));
    const filePath = 'escaped.txt';
    const absPath = path.join(dir, filePath);
    await fs.writeFile(absPath, 'hello\nworld\nafter');

    const result = await tool.execute({
      path: filePath,
      replacements: [
        {
          search_content: 'hello\\nworld',
          replace_content: 'replaced',
        },
      ],
    });

    const parsed = JSON.parse(result);
    t.true(parsed.output[0].success);

    const updated = await fs.readFile(absPath, 'utf8');
    t.is(updated, 'replaced\nafter');
  });
});

test.serial('execute trims whitespace around the whole search string as a fallback', async (t) => {
  await withTempDir(async (dir) => {
    const tool = createTool(createMockSettingsService({ 'tools.enableEditHealing': false }));
    const filePath = 'boundary-whitespace.txt';
    const absPath = path.join(dir, filePath);
    await fs.writeFile(absPath, 'before\nconst value = 1;\nafter');

    const result = await tool.execute({
      path: filePath,
      replacements: [
        {
          search_content: '\n  const value = 1;  \n',
          replace_content: 'const value = 2;',
        },
      ],
    });

    const parsed = JSON.parse(result);
    t.true(parsed.output[0].success);

    const updated = await fs.readFile(absPath, 'utf8');
    t.is(updated, 'before\nconst value = 2;\nafter');
  });
});

test.serial(
  'execute recovers a unique multiline block with matching anchors and a minor middle difference',
  async (t) => {
    await withTempDir(async (dir) => {
      const tool = createTool(createMockSettingsService({ 'tools.enableEditHealing': false }));
      const filePath = 'anchor-context.ts';
      const absPath = path.join(dir, filePath);
      await fs.writeFile(
        absPath,
        [
          'function calculate() {',
          '  const subtotal = getSubtotal();',
          '  const tax = subtotal * 0.2;',
          '  return subtotal + tax;',
          '}',
        ].join('\n'),
      );

      const result = await tool.execute({
        path: filePath,
        replacements: [
          {
            search_content: [
              'function calculate() {',
              '  const subtotal = getSubtotal();',
              '  const tax = subtotal * 0.18;',
              '  return subtotal + tax;',
              '}',
            ].join('\n'),
            replace_content: 'function calculate() {\n  return getSubtotal() * 1.2;\n}',
          },
        ],
      });

      const parsed = JSON.parse(result);
      t.true(parsed.output[0].success);

      const updated = await fs.readFile(absPath, 'utf8');
      t.is(updated, 'function calculate() {\n  return getSubtotal() * 1.2;\n}');
    });
  },
);

test.serial('needsApproval requires approval for anchor recovery outside the workspace', async (t) => {
  await withTempDir(async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'term2-search-replace-outside-'));
    const filePath = path.join(outsideDir, 'anchor-context.ts');
    try {
      await fs.writeFile(
        filePath,
        [
          'function calculate() {',
          '  const subtotal = getSubtotal();',
          '  const tax = subtotal * 0.2;',
          '  return subtotal + tax;',
          '}',
        ].join('\n'),
      );
      const tool = createTool(createMockSettingsService({ 'tools.enableEditHealing': false }));

      const result = await tool.needsApproval({
        path: filePath,
        replacements: [
          {
            search_content: [
              'function calculate() {',
              '  const subtotal = getSubtotal();',
              '  const tax = subtotal * 0.18;',
              '  return subtotal + tax;',
              '}',
            ].join('\n'),
            replace_content: 'function calculate() {\n  return getSubtotal() * 1.2;\n}',
          },
        ],
      });

      t.true(result);
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });
});

test.serial(
  'execute rejects anchor recovery when the selected span is much larger than the search string',
  async (t) => {
    await withTempDir(async (dir) => {
      const tool = createTool(createMockSettingsService({ 'tools.enableEditHealing': false }));
      const filePath = 'oversized-anchor.ts';
      const absPath = path.join(dir, filePath);
      const originalContent = [
        'function calculate() {',
        ...Array.from({ length: 40 }, (_, index) => `  const value${index} = ${index};`),
        '  return total;',
        '}',
      ].join('\n');
      await fs.writeFile(absPath, originalContent);

      const result = await tool.execute({
        path: filePath,
        replacements: [
          {
            search_content: ['function calculate() {', '  const subtotal = 1;', '  return total;', '}'].join('\n'),
            replace_content: 'function calculate() {\n  return 0;\n}',
          },
        ],
      });

      const parsed = JSON.parse(result);
      t.false(parsed.output[0].success);

      const unchanged = await fs.readFile(absPath, 'utf8');
      t.is(unchanged, originalContent);
    });
  },
);

test.serial('execute rejects multiple normalized matches', async (t) => {
  await withTempDir(async (dir) => {
    const tool = createTool(createMockSettingsService({ 'tools.enableEditHealing': false }));
    const filePath = 'normalized-multi.txt';
    const absPath = path.join(dir, filePath);
    await fs.writeFile(absPath, 'const foo = 1;\n   const bar = 2;\n---\nconst foo = 1;\tconst bar = 2;\n');

    const result = await tool.execute({
      path: filePath,
      replacements: [
        {
          search_content: 'const foo = 1; const bar = 2;',
          replace_content: 'const foo = 9; const bar = 9;',
        },
      ],
    });

    const parsed = JSON.parse(result);
    t.false(parsed.output[0].success);
    t.true(parsed.output[0].error.includes('normalized matches'));

    const unchanged = await fs.readFile(absPath, 'utf8');
    t.is(unchanged, 'const foo = 1;\n   const bar = 2;\n---\nconst foo = 1;\tconst bar = 2;\n');
  });
});

test.serial('execute does not match substrings in relaxed mode', async (t) => {
  await withTempDir(async (dir) => {
    const tool = createTool();
    const filePath = 'substring.txt';
    const absPath = path.join(dir, filePath);
    const originalContent = '  formatted text  ';
    await fs.writeFile(absPath, originalContent);

    const result = await tool.execute({
      path: filePath,
      replacements: [
        {
          search_content: '    format    ',
          replace_content: 'replacement',
        },
      ],
    });

    const parsed = JSON.parse(result);
    t.false(parsed.output[0].success);

    const unchanged = await fs.readFile(absPath, 'utf8');
    t.is(unchanged, originalContent);
  });
});

test.serial('execute normalizes CRLF search content to match LF file', async (t) => {
  await withTempDir(async (dir) => {
    const tool = createTool();
    const filePath = 'lf-file.txt';
    const absPath = path.join(dir, filePath);
    await fs.writeFile(absPath, 'line one\nline two\nline three');

    const result = await tool.execute({
      path: filePath,
      replacements: [
        {
          search_content: 'line one\r\nline two',
          replace_content: 'replaced',
        },
      ],
    });

    const parsed = JSON.parse(result);
    t.true(parsed.output[0].success);

    const updated = await fs.readFile(absPath, 'utf8');
    t.is(updated, 'replaced\nline three');
  });
});

test.serial('execute normalizes LF search content to match CRLF file', async (t) => {
  await withTempDir(async (dir) => {
    const tool = createTool();
    const filePath = 'crlf-file.txt';
    const absPath = path.join(dir, filePath);
    await fs.writeFile(absPath, 'line one\r\nline two\r\nline three');

    const result = await tool.execute({
      path: filePath,
      replacements: [
        {
          search_content: 'line one\nline two',
          replace_content: 'replaced',
        },
      ],
    });

    const parsed = JSON.parse(result);
    t.true(parsed.output[0].success);

    const updated = await fs.readFile(absPath, 'utf8');
    t.is(updated, 'replaced\r\nline three');
  });
});

test.serial('execute preserves CRLF in replacement content when file uses CRLF', async (t) => {
  await withTempDir(async (dir) => {
    const tool = createTool();
    const filePath = 'crlf-file.txt';
    const absPath = path.join(dir, filePath);
    await fs.writeFile(absPath, 'hello\r\nworld');

    const result = await tool.execute({
      path: filePath,
      replacements: [
        {
          search_content: 'hello',
          replace_content: 'new\nline',
        },
      ],
    });

    const parsed = JSON.parse(result);
    t.true(parsed.output[0].success);

    const updated = await fs.readFile(absPath, 'utf8');
    t.is(updated, 'new\r\nline\r\nworld');
  });
});

test.serial('execute strips leading filepath comment from search content', async (t) => {
  await withTempDir(async (dir) => {
    const tool = createTool();
    const filePath = 'sample.ts';
    const absPath = path.join(dir, filePath);
    await fs.writeFile(absPath, 'const x = 1;\nconst y = 2;');

    const result = await tool.execute({
      path: filePath,
      replacements: [
        {
          search_content: '// sample.ts\nconst x = 1;',
          replace_content: 'const x = 42;',
        },
      ],
    });

    const parsed = JSON.parse(result);
    t.true(parsed.output[0].success);

    const updated = await fs.readFile(absPath, 'utf8');
    t.is(updated, 'const x = 42;\nconst y = 2;');
  });
});

test.serial('execute strips leading hash filepath comment from search content', async (t) => {
  await withTempDir(async (dir) => {
    const tool = createTool();
    const filePath = 'script.py';
    const absPath = path.join(dir, filePath);
    await fs.writeFile(absPath, 'x = 1\ny = 2');

    const result = await tool.execute({
      path: filePath,
      replacements: [
        {
          search_content: '# script.py\nx = 1',
          replace_content: 'x = 42',
        },
      ],
    });

    const parsed = JSON.parse(result);
    t.true(parsed.output[0].success);

    const updated = await fs.readFile(absPath, 'utf8');
    t.is(updated, 'x = 42\ny = 2');
  });
});

test.serial('execute does not strip non-filepath leading comments', async (t) => {
  await withTempDir(async (dir) => {
    const tool = createTool();
    const filePath = 'code.ts';
    const absPath = path.join(dir, filePath);
    await fs.writeFile(absPath, '// TODO: fix this\nconst x = 1;');

    const result = await tool.execute({
      path: filePath,
      replacements: [
        {
          search_content: '// TODO: fix this\nconst x = 1;',
          replace_content: 'const x = 42;',
        },
      ],
    });

    const parsed = JSON.parse(result);
    t.true(parsed.output[0].success);

    const updated = await fs.readFile(absPath, 'utf8');
    t.is(updated, 'const x = 42;');
  });
});

test.serial('execute rejects search content with "Lines X-Y omitted" marker', async (t) => {
  await withTempDir(async (dir) => {
    const tool = createTool();
    const filePath = 'content.txt';
    const absPath = path.join(dir, filePath);
    await fs.writeFile(absPath, 'line 1\nline 2\nline 3');

    const result = await tool.execute({
      path: filePath,
      replacements: [
        {
          search_content: 'line 1\nLines 2-50 omitted\nline 3',
          replace_content: 'replaced',
        },
      ],
    });

    const parsed = JSON.parse(result);
    t.false(parsed.output[0].success);
    t.true(parsed.output[0].error.includes('omitted'));
  });
});

test.serial('execute rejects search content with ellipsis marker {…}', async (t) => {
  await withTempDir(async (dir) => {
    const tool = createTool();
    const filePath = 'content.txt';
    const absPath = path.join(dir, filePath);
    await fs.writeFile(absPath, 'function foo() { /* code */ }');

    const result = await tool.execute({
      path: filePath,
      replacements: [
        {
          search_content: 'function foo() {…}',
          replace_content: 'replaced',
        },
      ],
    });

    const parsed = JSON.parse(result);
    t.false(parsed.output[0].success);
    t.true(parsed.output[0].error.includes('ellipsis'));
  });
});

test.serial('execute rejects search content with /*...*/ marker', async (t) => {
  await withTempDir(async (dir) => {
    const tool = createTool();
    const filePath = 'content.txt';
    const absPath = path.join(dir, filePath);
    await fs.writeFile(absPath, 'function foo() { return 1; }');

    const result = await tool.execute({
      path: filePath,
      replacements: [
        {
          search_content: 'function foo() { /*...*/ }',
          replace_content: 'replaced',
        },
      ],
    });

    const parsed = JSON.parse(result);
    t.false(parsed.output[0].success);
    t.true(parsed.output[0].error.includes('/*...*/'));
  });
});

test.serial('execute rejects search content with // ... marker', async (t) => {
  await withTempDir(async (dir) => {
    const tool = createTool();
    const filePath = 'content.txt';
    const absPath = path.join(dir, filePath);
    await fs.writeFile(absPath, 'const a = 1;\nconst b = 2;\nconst c = 3;');

    const result = await tool.execute({
      path: filePath,
      replacements: [
        {
          search_content: 'const a = 1;\n// ...\nconst c = 3;',
          replace_content: 'replaced',
        },
      ],
    });

    const parsed = JSON.parse(result);
    t.false(parsed.output[0].success);
    t.true(parsed.output[0].error.includes('// ...'));
  });
});

test.serial('execute rejects search content when search and replace content are identical', async (t) => {
  await withTempDir(async (dir) => {
    const tool = createTool();
    const filePath = 'content.txt';
    const absPath = path.join(dir, filePath);
    await fs.writeFile(absPath, 'hello world');

    const result = await tool.execute({
      path: filePath,
      replacements: [
        {
          search_content: 'hello',
          replace_content: 'hello',
        },
      ],
    });

    const parsed = JSON.parse(result);
    t.false(parsed.output[0].success);
    t.regex(parsed.output[0].error, /identical/i);
  });
});

test.serial('needsApproval auto-approves when search and replace content are identical', async (t) => {
  await withTempDir(async (dir) => {
    const tool = createTool();
    const filePath = 'content.txt';
    const absPath = path.join(dir, filePath);
    await fs.writeFile(absPath, 'hello world');

    const result = await tool.needsApproval({
      path: filePath,
      replacements: [
        {
          search_content: 'hello',
          replace_content: 'hello',
        },
      ],
    });

    t.false(result);
  });
});

test.serial('execute performs gap match: head <...> tail replaces entire region', async (t) => {
  await withTempDir(async (dir) => {
    const tool = createTool(createMockSettingsService({ 'tools.enableEditHealing': false }));
    const filePath = 'content.txt';
    const absPath = path.join(dir, filePath);
    await fs.writeFile(
      absPath,
      'function foo() {\n  const x = 1;\n  const y = 2;\n  const z = 3;\n  return x + y + z;\n}\n',
    );

    const result = await tool.execute({
      path: filePath,
      replacements: [
        {
          search_content: 'function foo() {\n  const x = 1;\n<...>\n  return x + y + z;\n}',
          replace_content: 'function foo() {\n  return 6;\n}\n',
        },
      ],
    });

    const parsed = JSON.parse(result);
    t.true(parsed.output[0].success);
    t.true(parsed.output[0].message.includes('gap'));

    const updated = await fs.readFile(absPath, 'utf8');
    t.is(updated, 'function foo() {\n  return 6;\n}\n');
  });
});

test.serial('execute performs gap match with single-line head and tail', async (t) => {
  await withTempDir(async (dir) => {
    const tool = createTool(createMockSettingsService({ 'tools.enableEditHealing': false }));
    const filePath = 'content.txt';
    const absPath = path.join(dir, filePath);
    await fs.writeFile(absPath, 'start\nmiddle1\nmiddle2\nend\nafter');

    const result = await tool.execute({
      path: filePath,
      replacements: [
        {
          search_content: 'start\n<...>\nend',
          replace_content: 'replaced\n',
        },
      ],
    });

    const parsed = JSON.parse(result);
    t.true(parsed.output[0].success);

    const updated = await fs.readFile(absPath, 'utf8');
    t.is(updated, 'replaced\nafter');
  });
});

test.serial('execute performs gap match with adjacent head and tail (no actual gap content)', async (t) => {
  await withTempDir(async (dir) => {
    const tool = createTool(createMockSettingsService({ 'tools.enableEditHealing': false }));
    const filePath = 'content.txt';
    const absPath = path.join(dir, filePath);
    await fs.writeFile(absPath, 'line1\nline2\nline3');

    const result = await tool.execute({
      path: filePath,
      replacements: [
        {
          search_content: 'line1\n<...>\nline2',
          replace_content: 'replaced\n',
        },
      ],
    });

    const parsed = JSON.parse(result);
    t.true(parsed.output[0].success);

    const updated = await fs.readFile(absPath, 'utf8');
    t.is(updated, 'replaced\nline3');
  });
});

test.serial('execute performs gap match with multiple <...> markers', async (t) => {
  await withTempDir(async (dir) => {
    const tool = createTool(createMockSettingsService({ 'tools.enableEditHealing': false }));
    const filePath = 'content.txt';
    const absPath = path.join(dir, filePath);
    await fs.writeFile(
      absPath,
      'function a() {\n  body1;\n}\nfunction b() {\n  body2;\n}\nfunction c() {\n  body3;\n}\n',
    );

    const result = await tool.execute({
      path: filePath,
      replacements: [
        {
          search_content: 'function a() {\n<...>\nfunction b() {\n<...>\nfunction c() {\n  body3;\n}',
          replace_content: 'function abc() {\n  combined;\n}\n',
        },
      ],
    });

    const parsed = JSON.parse(result);
    t.true(parsed.output[0].success);

    const updated = await fs.readFile(absPath, 'utf8');
    t.is(updated, 'function abc() {\n  combined;\n}\n');
  });
});

test.serial('execute gap match fails when head is not found', async (t) => {
  await withTempDir(async (dir) => {
    const tool = createTool(createMockSettingsService({ 'tools.enableEditHealing': false }));
    const filePath = 'content.txt';
    const absPath = path.join(dir, filePath);
    await fs.writeFile(absPath, 'line1\nline2\nline3');

    const result = await tool.execute({
      path: filePath,
      replacements: [
        {
          search_content: 'nonexistent\n<...>\nline3',
          replace_content: 'replaced',
        },
      ],
    });

    const parsed = JSON.parse(result);
    t.false(parsed.output[0].success);
  });
});

test.serial('execute gap match fails when tail is not found after head', async (t) => {
  await withTempDir(async (dir) => {
    const tool = createTool(createMockSettingsService({ 'tools.enableEditHealing': false }));
    const filePath = 'content.txt';
    const absPath = path.join(dir, filePath);
    await fs.writeFile(absPath, 'line1\nline2\nline3');

    const result = await tool.execute({
      path: filePath,
      replacements: [
        {
          search_content: 'line1\n<...>\nnonexistent',
          replace_content: 'replaced',
        },
      ],
    });

    const parsed = JSON.parse(result);
    t.false(parsed.output[0].success);
  });
});

test.serial(
  'execute does not invoke healing for a failed gap pattern and reports a head-anchor diagnostic',
  async (t) => {
    await withTempDir(async (dir) => {
      let healingCalls = 0;
      const tool = createTool(createMockSettingsService({ 'tools.enableEditHealing': true }), async (params) => {
        healingCalls++;
        return { params, wasModified: false, confidence: 0 };
      });
      const filePath = 'content.txt';
      await fs.writeFile(path.join(dir, filePath), 'line1\nline2\nline3');

      const result = await tool.execute({
        path: filePath,
        replacements: [
          {
            search_content: 'nonexistent\n<...>\nline3',
            replace_content: 'replaced',
          },
        ],
      });

      const parsed = JSON.parse(result);
      t.false(parsed.output[0].success);
      t.is(healingCalls, 0);
      t.regex(parsed.output[0].error, /head anchor/i);
      t.regex(parsed.output[0].error, /not auto-healed/i);
    });
  },
);

test.serial('execute gap diagnostic identifies the anchor that failed after the head matched', async (t) => {
  await withTempDir(async (dir) => {
    const tool = createTool(createMockSettingsService({ 'tools.enableEditHealing': true }), async (params) => ({
      params,
      wasModified: false,
      confidence: 0,
    }));
    const filePath = 'content.txt';
    await fs.writeFile(path.join(dir, filePath), 'line1\nline2\nline3');

    const result = await tool.execute({
      path: filePath,
      replacements: [
        {
          search_content: 'line1\n<...>\nnonexistent',
          replace_content: 'replaced',
        },
      ],
    });

    const parsed = JSON.parse(result);
    t.false(parsed.output[0].success);
    t.regex(parsed.output[0].error, /not found after/i);
  });
});

test.serial('execute gap match rejects multiple matches', async (t) => {
  await withTempDir(async (dir) => {
    const tool = createTool(createMockSettingsService({ 'tools.enableEditHealing': false }));
    const filePath = 'content.txt';
    const absPath = path.join(dir, filePath);
    await fs.writeFile(absPath, 'start\nmiddle1\nend\nstart\nmiddle2\nend\n');

    const result = await tool.execute({
      path: filePath,
      replacements: [
        {
          search_content: 'start\n<...>\nend',
          replace_content: 'replaced',
        },
      ],
    });

    const parsed = JSON.parse(result);
    t.false(parsed.output[0].success);
    t.true(parsed.output[0].error.includes('gap'));
  });
});

test.serial('execute gap match works with relaxed whitespace matching in segments', async (t) => {
  await withTempDir(async (dir) => {
    const tool = createTool(createMockSettingsService({ 'tools.enableEditHealing': false }));
    const filePath = 'content.txt';
    const absPath = path.join(dir, filePath);
    await fs.writeFile(absPath, '  function foo() {\n  const x = 1;\n  const y = 2;\n  return x;\n  }\n');

    const result = await tool.execute({
      path: filePath,
      replacements: [
        {
          search_content: 'function foo() {\n<...>\nreturn x;\n}',
          replace_content: 'function foo() {\n  return 42;\n}\n',
        },
      ],
    });

    const parsed = JSON.parse(result);
    t.true(parsed.output[0].success);

    const updated = await fs.readFile(absPath, 'utf8');
    t.is(updated, 'function foo() {\n  return 42;\n}\n');
  });
});

test.serial('needsApproval handles gap match', async (t) => {
  await withTempDir(async (dir) => {
    const tool = createTool(createMockSettingsService());
    const filePath = 'content.txt';
    const absPath = path.join(dir, filePath);
    await fs.writeFile(absPath, 'start\nmiddle\nend\n');

    const result = await tool.needsApproval({
      path: filePath,
      replacements: [
        {
          search_content: 'start\n<...>\nend',
          replace_content: 'replaced',
        },
      ],
    });

    t.false(result);
  });
});
