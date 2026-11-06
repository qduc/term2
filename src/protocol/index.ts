/**
 * protocol/ — the one public wire format.
 *
 * Every client, local or remote, sees sessions only through these types.
 * Two files carry a message across this layer:
 *
 * - Inbound, `commands.ts` is the only wire-to-domain translation: it
 *   turns a client's `WireCommand` into one call on the live `DirectSession`.
 * - Outbound, `projection.ts` turns each accepted session update into
 *   `WireEvent`s once, folding them with `reducer.ts` into the snapshot a
 *   newly attached client renders from. It bounds sizes and strips private
 *   fields (paths, credentials, opaque provider state).
 *
 * `wire.ts` defines the format; `mapping.md` records how each
 * event maps to the old CLI's output. Clients import these files directly; this
 * index names the layer's public surface.
 * Depends on: session (and the types it re-exports).
 */

export { DIRECT_PROTOCOL_VERSION } from './wire.js';
export type {
  WireCommand as DirectWireCommand,
  WireCommandResult as DirectWireCommandResult,
  WireConfigureRequest as DirectWireConfigureRequest,
  WireEvent as DirectWireEvent,
  WireSnapshot as DirectWireSnapshot,
  WireMessage as DirectWireMessage,
  WireInteraction as DirectWireInteraction,
} from './wire.js';
export type { DirectCommandCapabilities } from './capabilities.js';
