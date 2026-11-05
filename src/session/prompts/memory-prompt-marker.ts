/** Replaced at the Session request boundary with the actual accepted memory
 * guidance/context. The source prompt must not guess whether the global index is
 * populated before Session takes its one snapshot. */
export const DIRECT_MEMORY_GUIDANCE_MARKER = '__TERM2_DIRECT_MEMORY_SECTION__';
