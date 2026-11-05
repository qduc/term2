/** An edited queue entry that began with an explicit skill request keeps that accepted prefix in the sent text. */
export const withSkillPrefix = (prefix: string | undefined, text: string): string =>
  prefix === undefined ? text : `${prefix}${text ? `\n\n${text}` : ''}`;
