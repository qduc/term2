/** What `cli.ts` hands the direct application after parsing. No Session or engine authority crosses here. */
import type { AcpArgs } from '../../../source/acp-v2/serve-args.js';
import type { ServeArgs } from '../../../source/gateway/serve-args.js';
import type { ProfileSelection } from './tool-contract.js';

/**
 * Built by `cli.ts`: logger, session context and settings with the chosen
 * profile, model and reasoning already applied with `{ persist: false }`. These
 * settings are read as the defaults for new sessions and are never handed to a
 * running session, because each session gets its own settings.
 */
export type DirectLaunchBase = {
  readonly conversationsDir: string;
  readonly selection: ProfileSelection;
  /** True only for an explicit profile flag, which overrides a resumed profile. */
  readonly profileExplicit?: boolean;
};

export type DirectControlSocketRequest = {
  /** Already checked with `isControlSocketName`; defaults to the pid in `cli.ts`. */
  readonly name: string;
  readonly discordInput: boolean;
};

export type DirectLaunchRequest =
  | (DirectLaunchBase & {
      readonly kind: 'interactive';
      /** Exact direct `conv_<uuid>`; absent starts a new session. */
      readonly resumeId?: string;
      /** Selects the home-directory confirmation, as the current CLI does. */
      readonly lite: boolean;
      readonly controlSocket?: DirectControlSocketRequest;
    })
  | (DirectLaunchBase & { readonly kind: 'acp'; readonly args: AcpArgs })
  | (DirectLaunchBase & { readonly kind: 'serve'; readonly args: ServeArgs })
  | { readonly kind: 'control'; readonly argv: readonly string[] }
  | { readonly kind: 'discord'; readonly argv: readonly string[] };
