import { it, expect } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { createSearchReplaceToolDefinition } from './search-replace.js';
import { createMockSettingsService } from '../../services/settings/settings-service.mock.js';
import type { ILoggingService } from '../../services/service-interfaces.js';

function parsePlainResult(result: string): any {
  const lines = result.split('\n').filter(Boolean);
  if (lines.length === 0) {
    return { success: false, error: 'No output', output: [{ success: false, error: 'No output' }] };
  }
  const output = lines.map((line) => {
    if (line.startsWith('Error: ')) {
      return { success: false, error: line.slice(7) };
    }
    return { success: true, message: line };
  });
  return { ...output[0], output };
}

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

it.sequential('needsApproval auto-approves creation when search_content is empty and file is missing', async () => {
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

    expect(result).toBe(false);
  });
});

it.sequential('needsApproval auto-approves a unique exact match', async () => {
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

    expect(result).toBe(false);
  });
});

it.sequential('needsApproval auto-approves when multiple exact matches are found', async () => {
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

    expect(result).toBe(false);
  });
});

it.sequential('execute replaces only a unique exact match', async () => {
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

    const parsed = parsePlainResult(result);
    expect(parsed.output[0].success).toBe(true);

    const updated = await fs.readFile(absPath, 'utf8');
    expect(updated).toBe('done before unique after');
  });
});

it.sequential('execute fails with a match_all hint when multiple exact matches are found', async () => {
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

    const parsed = parsePlainResult(result);
    expect(parsed.output[0].success).toBe(false);
    expect(parsed.output[0].error).toMatch(/Found 3 exact matches/);
    expect(parsed.output[0].error).toMatch(/Set match_all to true to replace all matches/);

    const updated = await fs.readFile(absPath, 'utf8');
    expect(updated).toBe('foo foo foo');
  });
});

it.sequential('execute replaces all exact matches when match_all is true', async () => {
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
          match_all: true,
        },
      ],
    });

    const parsed = parsePlainResult(result);
    expect(parsed.output[0].success).toBe(true);
    expect(parsed.output[0].message).toMatch(/3 exact matches/);

    const updated = await fs.readFile(absPath, 'utf8');
    expect(updated).toBe('bar bar bar');
  });
});

it.sequential('execute performs relaxed match replacement when exact match is not found', async () => {
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

    const parsed = parsePlainResult(result);
    expect(parsed.output[0].success).toBe(true);

    const updated = await fs.readFile(absPath, 'utf8');
    expect(updated).toBe('new block\nremainder');
  });
});

it.sequential('execute fails when multiple relaxed matches are found', async () => {
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

    const parsed = parsePlainResult(result);
    expect(parsed.output[0].success).toBe(false);
    expect(
      parsed.output[0].error.includes('relaxed matches') || parsed.output[0].error.includes('Found 2 relaxed matches'),
    ).toBe(true);

    const unchanged = await fs.readFile(absPath, 'utf8');
    expect(unchanged).toBe('  foo  \n\tbar\n---\n  foo  \n\tbar\n');
  });
});

it.sequential('execute replaces all relaxed matches when match_all is true', async () => {
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
          replace_content: 'replacement\n',
          match_all: true,
        },
      ],
    });

    const parsed = parsePlainResult(result);
    expect(parsed.output[0].success).toBe(true);
    expect(parsed.output[0].message).toMatch(/2 relaxed matches/);

    const updated = await fs.readFile(absPath, 'utf8');
    expect(updated).toBe('replacement\n---\nreplacement\n');
  });
});

it.sequential('execute creates a new file when search_content is empty and file is missing', async () => {
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

    const parsed = parsePlainResult(result);
    expect(parsed.output[0].success).toBe(true);

    const createdContent = await fs.readFile(absPath, 'utf8');
    expect(createdContent).toBe('new content');
  });
});

it.sequential('execute preserves parallel edits to different regions of the same file', async () => {
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
      const parsed = parsePlainResult(result);
      expect(parsed.output[0].success).toBe(true);
    }

    const updated = await fs.readFile(absPath, 'utf8');
    expect(updated.split('\n')).toEqual(tokens.map((_, index) => `done_${index}`));
  });
});

it.sequential('execute applies batched replacements to one file with a single result per edit', async () => {
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

    const parsed = parsePlainResult(result);
    expect(parsed.output.every((item: { success: boolean }) => item.success)).toBe(true);
    expect(parsed.output.length).toBe(2);
    expect(parsed.output.every((item: { message?: string }) => item.message?.includes(filePath))).toBe(true);

    const updated = await fs.readFile(absPath, 'utf8');
    expect(updated).toBe('ALPHA\nbeta\nGAMMA\n');
  });
});

it.sequential('execute keeps successful batched replacements when another replacement fails', async () => {
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

    const parsed = parsePlainResult(result);
    expect(parsed.output[0].success).toBe(true);
    expect(parsed.output[1].success).toBe(false);
    expect(parsed.output[2].success).toBe(true);

    const updated = await fs.readFile(absPath, 'utf8');
    expect(updated).toBe('ALPHA\nbeta\nGAMMA\n');
  });
});

it.sequential('execute reports failure when search string is not found', async () => {
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

    const parsed = parsePlainResult(result);
    expect(parsed.output[0].success).toBe(false);

    const unchanged = await fs.readFile(absPath, 'utf8');
    expect(unchanged).toBe(originalContent);
  });
});

it.sequential('execute heals search content when no match is found', async () => {
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

    const parsed = parsePlainResult(result);
    expect(parsed.output[0].success).toBe(true);
    expect(parsed.output[0].message.includes('auto healing')).toBe(true);

    const updated = await fs.readFile(absPath, 'utf8');
    expect(updated).toBe('const foo = 3;\n');
  });
});

it.sequential('execute includes auto-healing failure reason when healing does not find a match', async () => {
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

    const parsed = parsePlainResult(result);
    expect(parsed.output[0].success).toBe(false);
    expect(parsed.output[0].error.includes('model returned NO_MATCH')).toBe(true);
  });
});

it.sequential('execute treats special regex characters literally', async () => {
  await withTempDir(async (dir) => {
    const tool = createTool();
    const filePath = 'code.js';
    const absPath = path.join(dir, filePath);
    const originalContent = 'function it() { return [1, 2, 3]; }';
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

    const parsed = parsePlainResult(result);
    expect(parsed.output[0].success).toBe(true);

    const updated = await fs.readFile(absPath, 'utf8');
    expect(updated).toBe('function it() { return [4, 5, 6]; }');
  });
});

it.sequential('execute deletes content when replacement is empty string', async () => {
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

    const parsed = parsePlainResult(result);
    expect(parsed.output[0].success).toBe(true);

    const updated = await fs.readFile(absPath, 'utf8');
    expect(updated).toBe('before after');
  });
});

it.sequential('execute performs exact multi-line match without whitespace normalization', async () => {
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

    const parsed = parsePlainResult(result);
    expect(parsed.output[0].success).toBe(true);

    const updated = await fs.readFile(absPath, 'utf8');
    expect(updated).toBe('new content\nline three');
  });
});

it.sequential('execute handles leading/trailing whitespace differences in relaxed mode', async () => {
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

    const parsed = parsePlainResult(result);
    expect(parsed.output[0].success).toBe(true);

    const updated = await fs.readFile(absPath, 'utf8');
    expect(updated).toBe('replaced');
  });
});

it.sequential('execute performs normalized whitespace match across line breaks', async () => {
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

    const parsed = parsePlainResult(result);
    expect(parsed.output[0].success).toBe(true);

    const updated = await fs.readFile(absPath, 'utf8');
    expect(updated).toBe('const foo = 1;\nconst bar = 42;\nconst baz = 3;\n');
  });
});

it.sequential('execute matches escaped newline sequences in search content', async () => {
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

    const parsed = parsePlainResult(result);
    expect(parsed.output[0].success).toBe(true);

    const updated = await fs.readFile(absPath, 'utf8');
    expect(updated).toBe('replaced\nafter');
  });
});

it.sequential('execute trims whitespace around the whole search string as a fallback', async () => {
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

    const parsed = parsePlainResult(result);
    expect(parsed.output[0].success).toBe(true);

    const updated = await fs.readFile(absPath, 'utf8');
    expect(updated).toBe('before\nconst value = 2;\nafter');
  });
});

it.sequential(
  'execute recovers a unique multiline block with matching anchors and a minor middle difference',
  async () => {
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

      const parsed = parsePlainResult(result);
      expect(parsed.output[0].success).toBe(true);

      const updated = await fs.readFile(absPath, 'utf8');
      expect(updated).toBe('function calculate() {\n  return getSubtotal() * 1.2;\n}');
    });
  },
);

it.sequential('needsApproval requires approval for anchor recovery outside the workspace', async () => {
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

      expect(result).toBe(true);
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });
});

it.sequential(
  'execute rejects anchor recovery when the selected span is much larger than the search string',
  async () => {
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

      const parsed = parsePlainResult(result);
      expect(parsed.output[0].success).toBe(false);

      const unchanged = await fs.readFile(absPath, 'utf8');
      expect(unchanged).toBe(originalContent);
    });
  },
);

it.sequential('execute rejects multiple normalized matches', async () => {
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

    const parsed = parsePlainResult(result);
    expect(parsed.output[0].success).toBe(false);
    expect(parsed.output[0].error.includes('normalized matches')).toBe(true);

    const unchanged = await fs.readFile(absPath, 'utf8');
    expect(unchanged).toBe('const foo = 1;\n   const bar = 2;\n---\nconst foo = 1;\tconst bar = 2;\n');
  });
});

it.sequential('execute does not match substrings in relaxed mode', async () => {
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

    const parsed = parsePlainResult(result);
    expect(parsed.output[0].success).toBe(false);

    const unchanged = await fs.readFile(absPath, 'utf8');
    expect(unchanged).toBe(originalContent);
  });
});

it.sequential('execute normalizes CRLF search content to match LF file', async () => {
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

    const parsed = parsePlainResult(result);
    expect(parsed.output[0].success).toBe(true);

    const updated = await fs.readFile(absPath, 'utf8');
    expect(updated).toBe('replaced\nline three');
  });
});

it.sequential('execute normalizes LF search content to match CRLF file', async () => {
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

    const parsed = parsePlainResult(result);
    expect(parsed.output[0].success).toBe(true);

    const updated = await fs.readFile(absPath, 'utf8');
    expect(updated).toBe('replaced\r\nline three');
  });
});

it.sequential('execute preserves CRLF in replacement content when file uses CRLF', async () => {
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

    const parsed = parsePlainResult(result);
    expect(parsed.output[0].success).toBe(true);

    const updated = await fs.readFile(absPath, 'utf8');
    expect(updated).toBe('new\r\nline\r\nworld');
  });
});

it.sequential('execute strips leading filepath comment from search content', async () => {
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

    const parsed = parsePlainResult(result);
    expect(parsed.output[0].success).toBe(true);

    const updated = await fs.readFile(absPath, 'utf8');
    expect(updated).toBe('const x = 42;\nconst y = 2;');
  });
});

it.sequential('execute strips leading hash filepath comment from search content', async () => {
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

    const parsed = parsePlainResult(result);
    expect(parsed.output[0].success).toBe(true);

    const updated = await fs.readFile(absPath, 'utf8');
    expect(updated).toBe('x = 42\ny = 2');
  });
});

it.sequential('execute does not strip non-filepath leading comments', async () => {
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

    const parsed = parsePlainResult(result);
    expect(parsed.output[0].success).toBe(true);

    const updated = await fs.readFile(absPath, 'utf8');
    expect(updated).toBe('const x = 42;');
  });
});

it.sequential('execute rejects search content with "Lines X-Y omitted" marker', async () => {
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

    const parsed = parsePlainResult(result);
    expect(parsed.output[0].success).toBe(false);
    expect(parsed.output[0].error.includes('omitted')).toBe(true);
  });
});

it.sequential('execute rejects search content with ellipsis marker {…}', async () => {
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

    const parsed = parsePlainResult(result);
    expect(parsed.output[0].success).toBe(false);
    expect(parsed.output[0].error.includes('ellipsis')).toBe(true);
  });
});

it.sequential('execute rejects search content with /*...*/ marker', async () => {
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

    const parsed = parsePlainResult(result);
    expect(parsed.output[0].success).toBe(false);
    expect(parsed.output[0].error.includes('/*...*/')).toBe(true);
  });
});

it.sequential('execute rejects search content with // ... marker', async () => {
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

    const parsed = parsePlainResult(result);
    expect(parsed.output[0].success).toBe(false);
    expect(parsed.output[0].error.includes('// ...')).toBe(true);
  });
});

it.sequential('execute rejects search content when search and replace content are identical', async () => {
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

    const parsed = parsePlainResult(result);
    expect(parsed.output[0].success).toBe(false);
    expect(parsed.output[0].error).toMatch(/identical/i);
  });
});

it.sequential('needsApproval auto-approves when search and replace content are identical', async () => {
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

    expect(result).toBe(false);
  });
});

it.sequential('execute performs gap match: head <...> tail replaces entire region', async () => {
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

    const parsed = parsePlainResult(result);
    expect(parsed.output[0].success).toBe(true);
    expect(parsed.output[0].message.includes('gap')).toBe(true);

    const updated = await fs.readFile(absPath, 'utf8');
    expect(updated).toBe('function foo() {\n  return 6;\n}\n');
  });
});

it.sequential('execute performs gap match with single-line head and tail', async () => {
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

    const parsed = parsePlainResult(result);
    expect(parsed.output[0].success).toBe(true);

    const updated = await fs.readFile(absPath, 'utf8');
    expect(updated).toBe('replaced\nafter');
  });
});

it.sequential('execute performs gap match with adjacent head and tail (no actual gap content)', async () => {
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

    const parsed = parsePlainResult(result);
    expect(parsed.output[0].success).toBe(true);

    const updated = await fs.readFile(absPath, 'utf8');
    expect(updated).toBe('replaced\nline3');
  });
});

it.sequential('execute performs gap match with multiple <...> markers', async () => {
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

    const parsed = parsePlainResult(result);
    expect(parsed.output[0].success).toBe(true);

    const updated = await fs.readFile(absPath, 'utf8');
    expect(updated).toBe('function abc() {\n  combined;\n}\n');
  });
});

it.sequential('execute gap match fails when head is not found', async () => {
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

    const parsed = parsePlainResult(result);
    expect(parsed.output[0].success).toBe(false);
  });
});

it.sequential('execute gap match fails when tail is not found after head', async () => {
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

    const parsed = parsePlainResult(result);
    expect(parsed.output[0].success).toBe(false);
  });
});

it.sequential(
  'execute does not invoke healing for a failed gap pattern and reports a head-anchor diagnostic',
  async () => {
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

      const parsed = parsePlainResult(result);
      expect(parsed.output[0].success).toBe(false);
      expect(healingCalls).toBe(0);
      expect(parsed.output[0].error).toMatch(/head anchor/i);
      expect(parsed.output[0].error).toMatch(/not auto-healed/i);
    });
  },
);

it.sequential('execute gap diagnostic identifies the anchor that failed after the head matched', async () => {
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

    const parsed = parsePlainResult(result);
    expect(parsed.output[0].success).toBe(false);
    expect(parsed.output[0].error).toMatch(/not found after/i);
  });
});

it.sequential('execute gap match rejects multiple matches', async () => {
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

    const parsed = parsePlainResult(result);
    expect(parsed.output[0].success).toBe(false);
    expect(parsed.output[0].error.includes('gap')).toBe(true);
  });
});

it.sequential('execute gap match works with relaxed whitespace matching in segments', async () => {
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

    const parsed = parsePlainResult(result);
    expect(parsed.output[0].success).toBe(true);

    const updated = await fs.readFile(absPath, 'utf8');
    expect(updated).toBe('function foo() {\n  return 42;\n}\n');
  });
});

it.sequential('needsApproval handles gap match', async () => {
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

    expect(result).toBe(false);
  });
});

it.sequential('execute falls back to literal match when gap matching fails with standalone <...>', async () => {
  await withTempDir(async (dir) => {
    const tool = createTool(createMockSettingsService({ 'tools.enableEditHealing': false }));
    const filePath = 'literal-standalone-gap-fallback.txt';
    const absPath = path.join(dir, filePath);
    // File has <...> on its own line as literal text, without matching head anchors
    await fs.writeFile(absPath, 'prefix\n<...>\nsuffix\n');

    const result = await tool.execute({
      path: filePath,
      replacements: [
        {
          search_content: `<...>\nsuffix`,
          replace_content: 'replacement',
        },
      ],
    });

    const parsed = parsePlainResult(result);
    expect(parsed.output[0].success).toBe(true);

    const updated = await fs.readFile(absPath, 'utf8');
    expect(updated).toBe('prefix\nreplacement\n');
  });
});

it.sequential('execute matches literal <...> when not on a standalone line', async () => {
  await withTempDir(async (dir) => {
    const tool = createTool(createMockSettingsService({ 'tools.enableEditHealing': false }));
    const filePath = 'literal-inline.txt';
    const absPath = path.join(dir, filePath);
    await fs.writeFile(absPath, "export const GAP_MARKER = '<...>';\n");

    const result = await tool.execute({
      path: filePath,
      replacements: [
        {
          search_content: "export const GAP_MARKER = '<...>';",
          replace_content: 'export const GAP_MARKER = "___";',
        },
      ],
    });

    const parsed = parsePlainResult(result);
    expect(parsed.output[0].success).toBe(true);

    const updated = await fs.readFile(absPath, 'utf8');
    expect(updated).toBe('export const GAP_MARKER = "___";\n');
  });
});

it.sequential('execute performs gap match when input has literal \\n sequences', async () => {
  await withTempDir(async (dir) => {
    const tool = createTool(createMockSettingsService({ 'tools.enableEditHealing': false }));
    const filePath = 'unescape-gap.txt';
    const absPath = path.join(dir, filePath);
    await fs.writeFile(absPath, 'class MyClass {\n  myMethod() {\n    return 42;\n  }\n}\n');

    const result = await tool.execute({
      path: filePath,
      replacements: [
        {
          search_content: 'class MyClass {\\n<...>\\n  myMethod() {\\n    return 42;\\n  }\\n}',
          replace_content: 'class MyClass {\n  myMethod() { return 100; }\n}\n',
        },
      ],
    });

    const parsed = parsePlainResult(result);
    expect(parsed.output[0].success).toBe(true);

    const updated = await fs.readFile(absPath, 'utf8');
    expect(updated).toBe('class MyClass {\n  myMethod() { return 100; }\n}\n');
  });
});

it.sequential('execute gap match preserves blank lines inside anchors', async () => {
  await withTempDir(async (dir) => {
    const tool = createTool(createMockSettingsService({ 'tools.enableEditHealing': false }));
    const filePath = 'blank-lines-anchor.txt';
    const absPath = path.join(dir, filePath);
    await fs.writeFile(absPath, 'const a = 1;\n\nconst b = 2;\n// gap here\nconst c = 3;\n\nconst d = 4;\n');

    const result = await tool.execute({
      path: filePath,
      replacements: [
        {
          search_content: 'const a = 1;\n\nconst b = 2;\n<...>\nconst c = 3;\n\nconst d = 4;',
          replace_content: 'const replaced = true;\n',
        },
      ],
    });

    const parsed = parsePlainResult(result);
    expect(parsed.output[0].success).toBe(true);

    const updated = await fs.readFile(absPath, 'utf8');
    expect(updated).toBe('const replaced = true;\n');
  });
});

it.sequential('execute gap match works with normalized whitespace within lines', async () => {
  await withTempDir(async (dir) => {
    const tool = createTool(createMockSettingsService({ 'tools.enableEditHealing': false }));
    const filePath = 'whitespace-norm-gap.txt';
    const absPath = path.join(dir, filePath);
    await fs.writeFile(absPath, 'if (condition)  {\n  doSomething();\n  doOtherThing();\n  return  true;\n}\n');

    const result = await tool.execute({
      path: filePath,
      replacements: [
        {
          search_content: 'if (condition) {\n<...>\nreturn true;\n}',
          replace_content: 'if (condition) {\n  return false;\n}\n',
        },
      ],
    });

    const parsed = parsePlainResult(result);
    expect(parsed.output[0].success).toBe(true);

    const updated = await fs.readFile(absPath, 'utf8');
    expect(updated).toBe('if (condition) {\n  return false;\n}\n');
  });
});
