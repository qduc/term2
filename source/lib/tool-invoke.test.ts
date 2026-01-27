import test from 'ava';
import {tool as createTool, RunContext} from '@openai/agents';
import {z} from 'zod';
import {wrapToolInvoke} from './tool-invoke.js';

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

    const wrappedTool = wrapToolInvoke(rawTool);
    const result = await wrappedTool.invoke({} as RunContext, '{"value":"hi"}');

    t.is(result, 'ok:hi');
});
