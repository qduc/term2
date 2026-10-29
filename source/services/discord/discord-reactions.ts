import { z } from 'zod';

const snowflake = z.string().regex(/^[0-9]{1,24}$/);
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
/** One Unicode emoji grapheme or Discord's REST custom name:id form; never a URL or markup. */
export const discordEmoji = z
  .string()
  .min(1)
  .max(128)
  .refine(
    (value) =>
      /^[A-Za-z0-9_]{2,32}:[0-9]{1,24}$/.test(value) ||
      ([...segmenter.segment(value)].length === 1 &&
        /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(value)),
  );

/** Normalized Gateway feedback. Session-scoped sequence is replay identity, not a timestamp. */
export const discordReactionEvent = z
  .object({
    sessionId: z.string().min(1).max(256),
    sequence: z.number().int().nonnegative(),
    change: z.enum(['added', 'removed']),
    channelId: snowflake,
    userId: snowflake,
    messageId: snowflake,
    emoji: z
      .object({
        id: snowflake.nullable(),
        name: z.string().min(1).max(128).nullable(),
        animated: z.boolean().optional(),
      })
      .strict()
      .refine((emoji) => emoji.id !== null || emoji.name !== null),
    type: z.union([z.literal(0), z.literal(1)]),
  })
  .strict();
export type DiscordReactionEvent = z.infer<typeof discordReactionEvent>;
