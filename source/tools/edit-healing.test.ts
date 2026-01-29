import test from 'ava';
import type {SearchReplaceToolParams} from './search-replace.js';
// @ts-ignore - TS module resolution for new tool file
import {healSearchReplaceParams} from './edit-healing.js';

const baseParams: SearchReplaceToolParams = {
    path: 'file.txt',
    search_content: 'const foo = 2;\n',
    replace_content: 'const foo = 3;\n',
    replace_all: false,
};

test('healSearchReplaceParams returns modified params when model finds a match', async t => {
    const fileContent = 'const foo = 1;\n\tconst bar = 2;\n';
    const runModel = async () => 'const foo = 1;\n\tconst bar = 2;';

    const result = await healSearchReplaceParams(
        baseParams,
        fileContent,
        'gpt-4o-mini',
        'fake-key',
        {runModel},
    );

    t.true(result.wasModified);
    t.is(result.params.search_content, 'const foo = 1;\n\tconst bar = 2;');
    t.true(result.confidence >= 0.6);
});

test('healSearchReplaceParams returns unmodified params on NO_MATCH', async t => {
    const fileContent = 'const foo = 1;\n';
    const runModel = async () => 'NO_MATCH';

    const result = await healSearchReplaceParams(
        baseParams,
        fileContent,
        'gpt-4o-mini',
        'fake-key',
        {runModel},
    );

    t.false(result.wasModified);
    t.is(result.params.search_content, baseParams.search_content);
    t.is(result.confidence, 0);
});

test('healSearchReplaceParams returns unmodified params for ambiguous matches', async t => {
    const fileContent = 'alpha\nbeta\nalpha\nbeta\n';
    const runModel = async () => 'alpha\nbeta';

    const result = await healSearchReplaceParams(
        baseParams,
        fileContent,
        'gpt-4o-mini',
        'fake-key',
        {runModel},
    );

    t.false(result.wasModified);
    t.is(result.params.search_content, baseParams.search_content);
    t.is(result.confidence, 0);
});
