import { Agent, tool } from '@openai/agents';
import { z } from 'zod';
import { exec } from 'child_process';
import util from 'util';
import { OpenAI } from 'openai';
import { isSafeCommand } from './safety-checker.js';

const execPromise = util.promisify(exec);

export const client = new OpenAI();

const bashTool = tool({
  name: 'bash',
  description: 'Execute a bash command',
  parameters: z.object({
    command: z.string(),
  }),
  // Use AI safety checker to determine if approval is needed
  needsApproval: async ({ command }) => {
    const safetyResult = await isSafeCommand(command);
    // Store the safety result for use in the UI
    bashTool.lastSafetyCheck = safetyResult;
    return !safetyResult.safe;
  },
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
