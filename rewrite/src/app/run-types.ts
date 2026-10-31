/** App/client contract: exact direct resume only; no storage or engine authority. */
import type { HeadlessIo } from '../clients/headless/index.js';
import type { ProfileSelection } from './tool-contract.js';
export type RunRequest = {
  readonly prompt: string;
  readonly conversationsDir: string;
  readonly selection: ProfileSelection;
  readonly io: HeadlessIo;
  readonly autoApprove?: boolean;
  readonly resumeId?: string;
  /** CLI sets true only for explicit --profile/--lite, to override resumed profile. */
  readonly profileExplicit?: boolean;
};
export type RunResult = { readonly kind: 'completed' | 'cancelled' | 'failed' };
export type RunHandle = {
  readonly result: Promise<RunResult>;
  turnActive(): boolean;
  cancel(): void;
};
