import { z } from 'zod';
import { discordEmoji } from '../services/discord/discord-reactions.js';
import type { DiscordSend } from '../services/discord/discord-outbound.js';
import type { ScriptedToolDefinition } from './types.js';
import { createBaseMessage, getOutputText, isSuccessOutput } from './format-helpers.js';
import { TOOL_NAME_DISCORD_SEND } from './tool-names.js';

const requestId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
export const discordSendParameters = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('send'),
      requestId,
      text: z
        .string()
        .max(16_384)
        .refine((text) => !!text.trim()),
    })
    .strict(),
  z
    .object({
      action: z.literal('react'),
      requestId,
      messageId: z.string().regex(/^[0-9]{1,24}$/),
      emoji: discordEmoji,
    })
    .strict(),
  z.object({ action: z.literal('status'), requestId }).strict(),
]);

/** Explicit root notification capability; the host supplies identity and the bridge owns all credentials/effects. */
export function createDiscordSendToolDefinition(
  send: DiscordSend,
): ScriptedToolDefinition<typeof discordSendParameters> {
  return {
    name: TOOL_NAME_DISCORD_SEND,
    description:
      'Send a human-visible reply or proactive notification to the mapped Discord channel, or inspect its delivery status. ' +
      'Use action react with messageId and emoji (actual Unicode sequence, e.g. 👍 or 👩🏽‍💻, or custom name:id, not :shortcode: or Discord markup). ' +
      'React targets only your retained Discord human inputs or your acknowledged sent messages, in the configured channel. Normal reactions only; no remove or super reaction. ' +
      'Available only in an opted-in interactive root with the discord-send capability; the bridge may be offline. ' +
      'Use action send with a fresh requestId (1–64 ASCII letters/digits/_/-) and nonblank text (max 16,384 UTF-16 units). ' +
      'The bridge derives sender alias and channel; @worker is literal notification text, not peer routing. ' +
      'queued means durable local admission, NOT delivery; sent means all chunks acknowledged; uncertain means an ambiguous Discord effect that will not be retried. ' +
      'unknown means the bridge may have admitted the request before disconnection. Use action status with the SAME requestId to reconcile; ' +
      'never automatically send again with a replacement ID. Identical replay returns status; changed action, text, target or emoji conflicts. messageIds lists acknowledged text chunks; reaction identifies a reaction operation. A rejected reaction may mean missing permissions, invalid emoji or deleted target. ' +
      'unavailable means no mutation attempt; missing is not proof of non-delivery; rejected means no new admission.',
    parameters: discordSendParameters,
    scriptedReturnSchema: z
      .object({
        requestId: z.string(),
        delivery: z.enum(['queued', 'sent', 'uncertain', 'rejected', 'missing', 'unavailable', 'unknown']),
        reason: z.string().optional(),
        capacity: z
          .object({
            kind: z.enum(['pending', 'journal_bytes']),
            used: z.number().int().nonnegative(),
            limit: z.number().int().positive(),
          })
          .optional(),
        channelId: z.string().optional(),
        senderAlias: z.string().optional(),
        messageIds: z.array(z.string()).optional(),
        reaction: z.object({ messageId: z.string(), emoji: z.string() }).strict().optional(),
        chunks: z
          .object({
            queued: z.number().int().nonnegative(),
            sent: z.number().int().nonnegative(),
            uncertain: z.number().int().nonnegative(),
            rejected: z.number().int().nonnegative().optional(),
          })
          .optional(),
      })
      .strict(),
    needsApproval: () => false,
    execute: async (input) => send(input),
    formatCommandMessage: (item, index) => [
      createBaseMessage(item, index, 0, false, {
        command: TOOL_NAME_DISCORD_SEND,
        toolName: TOOL_NAME_DISCORD_SEND,
        output: getOutputText(item),
        success: isSuccessOutput(getOutputText(item)),
      }),
    ],
  };
}
