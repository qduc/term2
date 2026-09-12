import { createHash } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { buildEnvOverrides, SettingsService } from '../services/settings/settings-service.js';
import { LoggingService } from '../services/logging/logging-service.js';
import { getDefaultShellSandboxRunner } from '../utils/shell/sandbox/shell-sandbox-runner.js';
import { launchGateway } from './launcher.js';
import type { GatewayLaunchConfig, Term2Gateway } from './gateway.js';
import type { GatewaySafeLogMetadata, WorkspaceGrant } from './contracts.js';
import { createProductionRuntimeFactory } from './runtime-factory.js';
import { createGatewayStorageLayout } from './persistence/storage.js';
import { GatewayPersistenceCoordinator } from './persistence/coordinator.js';
import {
  loadGatewayManifest,
  validateDynamicGrant,
  validateGatewayManifest,
  WorkspaceAdmission,
} from './workspace-admission.js';
import { DynamicWorkspaceRegistry } from './dynamic-workspace-registry.js';
import { createRealWorkspaceBoundaryProbe } from './workspace-boundary-probe.js';
import { parseServeArgs } from './serve-args.js';

/**
 * `term2 serve` entry point: compose the real settings authority, the
 * production runtime factory, and the gateway control plane, then block until
 * SIGINT/SIGTERM triggers the existing bounded shutdown.
 *
 * State layout under --state-dir (0700): manifest.json + manifest.sha256,
 * replay.sqlite, trusted-clients.json (0600, written by TrustedClientsStore),
 * dynamic-workspaces.json (0600, durable browser-selected grants),
 * gateway-data/ (persistence coordinator), runtime-tmp/ + sandbox/
 * (per-session scratch), gateway-audit.jsonl.
 */

/** A launcher precondition failed; runServe turns this into a stderr message and exit 1. */
export class ServeStartupError extends Error {}

/**
 * Derive the gateway manifest for a state dir. A state dir with no manifest
 * (or an empty-grant manifest) gets the canonical empty manifest this launcher
 * runs: workspace admission is extended at runtime by the browser-owned
 * candidate registry, and that state is durable in dynamic-workspaces.json,
 * not in the manifest. A manifest that already carries curated grants is
 * preserved untouched; only its sha256 sidecar is refreshed.
 */
export function prepareGatewayManifest(stateDir: string): { manifestPath: string; manifestSha256: string } {
  const manifestPath = path.join(stateDir, 'manifest.json');
  const emptyManifest = `${JSON.stringify({ version: 1, grants: [], sshTargets: [] }, null, 2)}\n`;
  let manifestJson = emptyManifest;
  if (existsSync(manifestPath)) {
    const existingRaw = readFileSync(manifestPath, 'utf8');
    let existingGrants = 0;
    try {
      existingGrants = validateGatewayManifest(JSON.parse(existingRaw)).grants.length;
    } catch (error) {
      throw new ServeStartupError(
        `refusing to overwrite an unreadable gateway manifest at ${manifestPath}: ${messageOf(error)}`,
      );
    }
    if (existingGrants > 0) manifestJson = existingRaw;
  }
  const manifestSha256 = createHash('sha256').update(manifestJson).digest('hex');
  writeFileSync(manifestPath, manifestJson, { mode: 0o600 });
  writeFileSync(path.join(stateDir, 'manifest.sha256'), `${manifestSha256}\n`, { mode: 0o600 });
  // Prove the artifact the startup assertion will re-read actually parses.
  loadGatewayManifest(manifestPath, manifestSha256);
  return { manifestPath, manifestSha256 };
}

/**
 * Load durable browser-selected grants. A missing file means no prior grants;
 * a damaged (unparseable) file is quarantined as <file>.corrupt.<timestamp>
 * with a warning so the evidence survives (the unique suffix keeps a second
 * incident from destroying the first) and the launcher starts empty; a file
 * that parses but carries an invalid grant list fails closed.
 */
export function loadDynamicWorkspaceGrants(stateDir: string): readonly WorkspaceGrant[] {
  const grantsFile = path.join(stateDir, 'dynamic-workspaces.json');
  let raw: string;
  try {
    raw = readFileSync(grantsFile, 'utf8');
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // rename(2) replaces an existing destination, so the quarantine name
    // carries a timestamp: a second incident must not destroy the first.
    const quarantinePath = `${grantsFile}.corrupt.${Date.now()}`;
    let moved = false;
    try {
      renameSync(grantsFile, quarantinePath);
      moved = true;
    } catch {
      // Keep the damaged file in place rather than lose the evidence.
    }
    console.error(
      moved
        ? `term2 serve: ${grantsFile} is damaged; moved to ${quarantinePath}, starting with no dynamic grants`
        : `term2 serve: ${grantsFile} is damaged and could not be moved aside; leaving it in place — repair or delete it before the next start`,
    );
    return [];
  }
  if (!Array.isArray(parsed) || !parsed.every((entry) => validateDynamicGrant(entry))) {
    throw new ServeStartupError(`${grantsFile} contains an invalid dynamic grant; refusing to start`);
  }
  return parsed;
}

/** Write the durable grant list atomically (temp file, then rename). */
export function saveDynamicWorkspaceGrants(stateDir: string, grants: readonly WorkspaceGrant[]): void {
  const grantsFile = path.join(stateDir, 'dynamic-workspaces.json');
  const tempPath = `${grantsFile}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(grants, null, 2)}\n`, { mode: 0o600 });
  renameSync(tempPath, grantsFile);
}

/** Canonicalize one --workspace-root; the registry requires real directories. */
export function canonicalizeWorkspaceRoot(root: string): string {
  let canonical: string;
  try {
    canonical = realpathSync(root);
    if (!statSync(canonical).isDirectory()) throw new Error('not a directory');
  } catch (error) {
    throw new ServeStartupError(`--workspace-root ${root} is unusable: ${messageOf(error)}`);
  }
  return canonical;
}

/**
 * Startup sandbox availability never gates readiness and no consumer may read
 * workerSandboxAvailable as proof of a usable sandbox. This warning tells the
 * operator up front when every shell tool call will be refused.
 */
export function sandboxStartupWarning(availability: { type: string; reason?: string }): string | undefined {
  if (availability.type === 'available') return undefined;
  const detail = availability.reason ? ` (${availability.reason})` : '';
  return `term2 serve: warning: shell sandbox unavailable: ${availability.type}${detail}; shell tool calls will be refused`;
}

export async function runServe(argv: readonly string[]): Promise<void> {
  const parsed = parseServeArgs(argv);
  if (!parsed.ok) {
    console.error(`term2 serve: ${parsed.error}`);
    process.exit(1);
  }
  const args = parsed.args;

  let stateDir: string;
  try {
    mkdirSync(args.stateDir, { recursive: true, mode: 0o700 });
    chmodSync(args.stateDir, 0o700);
    stateDir = realpathSync(args.stateDir);
  } catch (error) {
    console.error(`term2 serve: cannot create state directory ${args.stateDir}: ${messageOf(error)}`);
    process.exit(1);
  }

  let manifest: { manifestPath: string; manifestSha256: string };
  try {
    manifest = prepareGatewayManifest(stateDir);
  } catch (error) {
    console.error(`term2 serve: ${messageOf(error)}`);
    process.exit(1);
  }
  const { manifestPath, manifestSha256 } = manifest;

  const publicKeys = new Map<string, string>();
  for (const { kid, pemPath } of args.bffKeys) {
    try {
      publicKeys.set(kid, readFileSync(pemPath, 'utf8'));
    } catch (error) {
      console.error(`term2 serve: cannot read BFF public key "${kid}" at ${pemPath}: ${messageOf(error)}`);
      process.exit(1);
    }
  }
  if (publicKeys.size === 0 && !args.pairing) {
    console.error('term2 serve: provide at least one --bff-key <kid>=<pem path> or enable --pairing');
    process.exit(1);
  }
  if (args.transport.kind === 'tls') {
    for (const label of ['tls-cert', 'tls-key'] as const) {
      const filePath = label === 'tls-cert' ? args.transport.certPath : args.transport.keyPath;
      try {
        readFileSync(filePath);
      } catch (error) {
        console.error(`term2 serve: cannot read --${label} at ${filePath}: ${messageOf(error)}`);
        process.exit(1);
      }
    }
  }

  let workspaceRoots: string[];
  try {
    workspaceRoots = args.workspaceRoots.map((root) => canonicalizeWorkspaceRoot(root));
  } catch (error) {
    console.error(`term2 serve: ${messageOf(error)}`);
    process.exit(1);
  }

  // Probe once for the operator-visible warning. This does not gate readiness:
  // the shell tool refuses the unsandboxed fallback per command when the
  // sandbox runtime is unusable, so sessions still start and every other tool
  // keeps working. The probe is advisory only: a throw from the optional
  // sandbox subsystem becomes a probe_failed warning, never a stack trace.
  let sandboxWarning: string | undefined;
  try {
    sandboxWarning = sandboxStartupWarning(await getDefaultShellSandboxRunner().availability());
  } catch (error) {
    sandboxWarning = sandboxStartupWarning({ type: 'probe_failed', reason: messageOf(error) });
  }

  // The launcher process is the credential owner: this is the operator's real
  // settings service (loaded with the same env precedence as the CLI), not a
  // per-session overlay. Sessions receive only the M1 allowlist.
  const settingsAuthority = new SettingsService({
    env: buildEnvOverrides(),
    loggingService: new LoggingService({ disableLogging: true, suppressConsoleOutput: true }),
  });

  const runtimeFactory = createProductionRuntimeFactory({
    settingsAuthority,
    tmpDir: ensureDir(stateDir, 'runtime-tmp'),
    sandboxAvailable: true,
  });

  const persistence = new GatewayPersistenceCoordinator(
    createGatewayStorageLayout(ensureDir(stateDir, 'gateway-data')),
  );

  let initialDynamicGrants: readonly WorkspaceGrant[];
  try {
    initialDynamicGrants = loadDynamicWorkspaceGrants(stateDir);
  } catch (error) {
    console.error(`term2 serve: ${messageOf(error)}`);
    process.exit(1);
  }
  const boundaryProbe = createRealWorkspaceBoundaryProbe({ allowWrite: args.allowWrite });
  const admission = new WorkspaceAdmission(loadGatewayManifest(manifestPath, manifestSha256), {
    allowWrite: args.allowWrite,
    boundaryProbe,
    initialDynamicGrants,
    onDynamicGrantChange: (grants) => {
      mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      saveDynamicWorkspaceGrants(stateDir, grants);
    },
  });
  const workspaceRegistry = new DynamicWorkspaceRegistry({
    admission,
    allowedRoots: workspaceRoots,
  });

  const auditPath = path.join(stateDir, 'gateway-audit.jsonl');
  const auditWriter = async (record: GatewaySafeLogMetadata) => {
    await appendFile(auditPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  };

  const config: GatewayLaunchConfig = {
    enabled: true,
    ...(args.transport.kind === 'socket'
      ? { socketPath: args.transport.socketPath }
      : {
          host: args.transport.host,
          port: args.transport.port,
          tls: { certPath: args.transport.certPath, keyPath: args.transport.keyPath, requireClientCert: false },
        }),
    manifestPath,
    manifestSha256,
    replayDbPath: path.join(stateDir, 'replay.sqlite'),
    issuer: args.issuer,
    audience: args.audience,
    publicKeys,
    localOwnerUserId: args.localOwnerUserId,
    workspaceRegistry,
    workspaceBoundaryProbe: boundaryProbe,
    // Launch-config claim only: the startup assertion requires this literal,
    // and no consumer may read it as proof of a usable sandbox. Real shell
    // execution probes the runner per call and refuses the unsandboxed
    // fallback; the startup warning tells the operator when that will happen.
    workerSandboxAvailable: true,
    tmpDir: ensureDir(stateDir, 'sandbox'),
    sshEnabled: false,
    allowWrite: args.allowWrite,
    autoApprove: false,
    allowUnsandboxed: false,
    auditWriter,
    // The launcher owns the diagnostics destination; the gateway only decides what is
    // worth reporting. Without this the gateway would have nowhere to report a degraded
    // shutdown audit.
    logger: new LoggingService(),
    runtimeFactory,
    // Always wired: without it session_create answers with the legacy body
    // shape, which the ChatForge BFF rejects as gateway_unavailable.
    persistence,
    ...(args.pairing
      ? {
          pairing: {
            enabled: true,
            trustFilePath: path.join(stateDir, 'trusted-clients.json'),
            // The OTP is the operator's out-of-band secret: stderr only, so it
            // can never interleave with a machine-readable stdout stream.
            printOtp: (otp: string) => console.error(`PAIRING OTP: ${otp}`),
          },
        }
      : {}),
  };

  // The CLI module registers global SIGINT/SIGTERM handlers that force-exit
  // for interactive sessions. A gateway shutdown is bounded and must be given
  // the chance to finish, so those listeners are replaced here.
  process.removeAllListeners('SIGINT');
  process.removeAllListeners('SIGTERM');

  let gateway: Term2Gateway;
  try {
    gateway = await launchGateway(config);
  } catch (error) {
    console.error(`term2 serve: gateway failed to start: ${messageOf(error)}`);
    process.exit(1);
  }

  if (sandboxWarning) console.error(sandboxWarning);
  const endpoint =
    args.transport.kind === 'socket'
      ? `transport=socket path=${args.transport.socketPath}`
      : `transport=tls host=${args.transport.host} port=${args.transport.port}`;
  console.error(
    `GATEWAY_READY pid=${process.pid} ${endpoint} pairing=${
      args.pairing ? 'on' : 'off'
    } workspaceRoots=${workspaceRoots.join(',')}`,
  );

  // launchGateway's own handlers start the bounded shutdown; this once-handler
  // awaits the same idempotent shutdown and then exits deterministically even
  // if a library keeps the event loop alive. runServe stays pending until that
  // shutdown finishes, so a caller cannot fall through and exit the process
  // while the gateway is still serving.
  let settleShutdown: () => void = () => undefined;
  const shutdownComplete = new Promise<void>((resolve) => {
    settleShutdown = resolve;
  });
  const shutdownAndExit = () => {
    void gateway.shutdown().finally(() => {
      settleShutdown();
      process.exit(0);
    });
  };
  process.once('SIGINT', shutdownAndExit);
  process.once('SIGTERM', shutdownAndExit);
  await shutdownComplete;
}

function ensureDir(stateDir: string, leaf: string): string {
  const dir = path.join(stateDir, leaf);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
