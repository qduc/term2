import { Agent, tool } from '@openai/agents';
import { z } from 'zod';
import { exec } from 'child_process';
import util from 'util';
import { OpenAI } from 'openai';

const execPromise = util.promisify(exec);

export const client = new OpenAI();

const bashTool = tool({
  name: 'bash',
  description: 'Execute a bash command',
  parameters: z.object({
    command: z.string(),
  }),
  // Require approval for all commands
  needsApproval: async () => true,
  execute: async ({ command }) => {
    try {
      const { stdout, stderr } = await execPromise(command);
      if (stderr) {
        return `Error: ${stderr}`;
      }
      return stdout;
    } catch (error) {
      return `Error executing command: ${error.message}`;
    }
  },
});

export const agent = new Agent({
  name: 'Terminal Assistant',
  instructions: 'You are a helpful terminal assistant. You can execute bash commands to help the user. Be proactive and proceed when the user intention is clear.',
  tools: [bashTool],
});
