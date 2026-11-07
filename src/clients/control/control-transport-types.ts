/** The v1 control schema is unchanged; durable bridge-result reads are internal. */
import type {
  BridgeOutcome,
  ControlMutationReceipt,
  ControlSessionPort as V1ControlSessionPort,
  ControlSocketOptions as V1ControlSocketOptions,
} from '../control-socket/control-socket.js';

export type ControlBridgeResult =
  | (BridgeOutcome & { readonly receipt?: ControlMutationReceipt })
  | { readonly state: 'missing' };
export interface ControlSessionPort extends V1ControlSessionPort {
  /** Read an actual persisted/public submission result in preference to process-local cache. */
  bridgeResult?(params: {
    readonly sessionId: string;
    readonly clientRequestId: string;
  }): ControlBridgeResult | Promise<ControlBridgeResult>;
}
export type ControlSocketOptions = Omit<V1ControlSocketOptions, 'port'> & {
  readonly port?: ControlSessionPort | null;
};
