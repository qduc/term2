import test from 'ava';
import {tool as createTool} from '@openai/agents';
import {z} from 'zod';
import {wrapToolInvoke} from './tool-invoke.js';
import type {FunctionTool} from '@openai/agents';

test('wrapToolInvoke stringifies object inputs for tool invocations', async t => {
    const rawTool = createTool({
        name: 'echo_tool',
        description: 'A test tool that echoes the input value',
        parameters: z.object({
            value: z.string(),
        }),
        strict: true,
        execute: async params => `ok:${params.value}`,
    });

    const wrappedTool = wrapToolInvoke(rawTool) as FunctionTool;
    const result = await wrappedTool.invoke({} as any, '{"value":"hi"}', {} as any);

    t.is(result, 'ok:hi');
});
