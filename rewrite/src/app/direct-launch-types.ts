/** What `cli.ts` hands the direct application after parsing. No Session or engine authority crosses here. */
import type { AcpArgs } from '../../../source/acp-v2/serve-args.js';
import type { ServeArgs } from '../../../source/gateway/serve-args.js';
import type { RunHandle, RunRequest } from './run-types.js';
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

/** Null port means none was given, so SSH config decides. An explicit 22 still wins over it. */
export type DirectSshRequest = {
  readonly target: string;
  readonly remoteDir: string | null;
  readonly port: number | null;
};

/** A headless run. Output modes live here because only the host client reads them. */
export type DirectHeadlessRequest = RunRequest & {
  readonly output?: 'plain' | 'json';
  /** Reasoning deltas go to stderr, never stdout. */
  readonly showReasoning?: boolean;
  /** Drops non-error event lines from stderr. */
  readonly quiet?: boolean;
  readonly ssh?: DirectSshRequest;
  /** Lets `ssh` omit `remoteDir`. */
  readonly lite?: boolean;
  /** With `resumeId`: continue on a new copy and leave that session as it is. */
  readonly fork?: boolean;
};

/** `context_paused` and `blocked` are the resumable stops that exit 2. */
export type DirectHeadlessResult = {
  readonly kind: 'completed' | 'cancelled' | 'failed' | 'context_paused' | 'blocked';
};
export type DirectHeadlessHandle = Omit<RunHandle, 'result'> & { readonly result: Promise<DirectHeadlessResult> };

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
      readonly ssh?: DirectSshRequest;
      /** With `resumeId`: continue on a new copy and leave that session as it is. */
      readonly fork?: boolean;
    })
  | (DirectLaunchBase & { readonly kind: 'acp'; readonly args: AcpArgs })
  | (DirectLaunchBase & { readonly kind: 'serve'; readonly args: ServeArgs })
  | { readonly kind: 'control'; readonly argv: readonly string[] }
  | { readonly kind: 'discord'; readonly argv: readonly string[] };
