/** Detail types whose owner is the host application, not the fold (see WireHostTypes). */

/**
 * Detail types the host owns. The fold never reads inside them; a host narrows one by augmenting this
 * interface (term2 does in ../wire.ts), and without that it is the fallback below.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- an augmentation slot, filled by the host.
export interface WireHostTypes {}
type HostType<K extends string, Fallback> = WireHostTypes extends { readonly [key in K]: infer T } ? T : Fallback;
/** Exact accepted public terminal evidence from the root audit; no provider history or private items. */
export type WireFinalWindow = HostType<'finalWindow', unknown>;
/** One priced or unpriced model request. The fold reads only `requestId`. */
export type WireModelRequestCost = HostType<
  'modelRequestCost',
  { readonly requestId: string; readonly [field: string]: unknown }
>;
/** Codex plan usage for one window. */
export type WireCodexQuota = { readonly usedPercent: number; readonly resetAt: number };
