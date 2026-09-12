import { createHash } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { buildEnvOverrides, SettingsService } from '../services/settings/settings-service.js';
import { LoggingService } from '../services/logging/logging-service.js';
import { launchGateway } from './launcher.js';
import type { GatewayLaunchConfig, Term2Gateway } from './gateway.js';
import type { GatewaySafeLogMetadata } from './contracts.js';
import { createProductionRuntimeFactory } from './runtime-factory.js';
import { createGatewayStorageLayout } from './persistence/storage.js';
import { GatewayPersistenceCoordinator } from './persistence/coordinator.js';
import { loadGatewayManifest, validateDynamicGrant, WorkspaceAdmission } from './workspace-admission.js';
import type { WorkspaceGrant } from './contracts.js';
import { DynamicWorkspaceRegistry } from './dynamic-workspace-registry.js';
import { createRealWorkspaceBoundaryProbe } from './workspace-boundary-probe.js';
import { parseServeArgs } from './serve-args.js';

/**
 * `term2 serve` entry point: compose the real settings authority, the
 * production runtime factory, and the gateway control plane, then block until
 * SIGINT/SIGTERM triggers the existing bounded shutdown.
 *
 * State layout under --state-dir (0700): manifest.json + manifest.sha256
 * (derived here at startup; static grants stay empty because dynamic
 * workspaces are the ChatForge path), replay.sqlite, trusted-clients.json
 * (0600, written by TrustedClientsStore), dynamic-workspaces.json (0600,
 * durable browser-selected grants), gateway-data/ (persistence coordinator),
 * runtime-tmp/ + sandbox/ (per-session scratch), gateway-audit.jsonl.
 */
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

  // A manifest with no static grants is correct here: workspace admission is
  // extended at runtime by the browser-owned candidate registry, and that
  // state is durable in dynamic-workspaces.json, not in the manifest.
  const manifestJson = `${JSON.stringify({ version: 1, grants: [], sshTargets: [] }, null, 2)}\n`;
  const manifestPath = path.join(stateDir, 'manifest.json');
  const manifestSha256 = createHash('sha256').update(manifestJson).digest('hex');
  try {
    writeFileSync(manifestPath, manifestJson, { mode: 0o600 });
    writeFileSync(path.join(stateDir, 'manifest.sha256'), `${manifestSha256}\n`, { mode: 0o600 });
    // Prove the artifact the startup assertion will re-read actually parses.
    loadGatewayManifest(manifestPath, manifestSha256);
  } catch (error) {
    console.error(`term2 serve: cannot write gateway manifest: ${messageOf(error)}`);
    process.exit(1);
  }

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

  // workerSandboxAvailable is the launch-config claim the gateway startup
  // assertion requires. Actual shell execution stays fail closed at the tool
  // boundary: when the sandbox runtime is unavailable the shell tool refuses
  // the unsandboxed fallback instead of running the command.

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

  const dynamicGrantsFile = path.join(stateDir, 'dynamic-workspaces.json');
  let initialDynamicGrants: readonly WorkspaceGrant[] = [];
  try {
    const parsedGrants: unknown = JSON.parse(readFileSync(dynamicGrantsFile, 'utf8'));
    if (Array.isArray(parsedGrants)) {
      if (!parsedGrants.every((entry) => validateDynamicGrant(entry))) {
        console.error(`term2 serve: ${dynamicGrantsFile} contains an invalid dynamic grant; refusing to start`);
        process.exit(1);
      }
      initialDynamicGrants = parsedGrants;
    }
  } catch {
    // Missing or corrupt file: start empty. A file that parses to an invalid
    // grant list already failed closed above.
  }
  const boundaryProbe = createRealWorkspaceBoundaryProbe({ allowWrite: args.allowWrite });
  const admission = new WorkspaceAdmission(loadGatewayManifest(manifestPath, manifestSha256), {
    allowWrite: args.allowWrite,
    boundaryProbe,
    initialDynamicGrants,
    onDynamicGrantChange: (grants) => {
      mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      writeFileSync(dynamicGrantsFile, `${JSON.stringify(grants, null, 2)}\n`, { mode: 0o600 });
    },
  });
  const workspaceRegistry = new DynamicWorkspaceRegistry({
    admission,
    // Browser-selected workspaces must live under the operator's home by
    // default; a single-user local launcher has no broader allowlist to serve.
    allowedRoots: [homedir()],
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
    workerSandboxAvailable: true,
    tmpDir: ensureDir(stateDir, 'sandbox'),
    sshEnabled: false,
    allowWrite: args.allowWrite,
    autoApprove: false,
    allowUnsandboxed: false,
    auditWriter,
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

  const endpoint =
    args.transport.kind === 'socket'
      ? `transport=socket path=${args.transport.socketPath}`
      : `transport=tls host=${args.transport.host} port=${args.transport.port}`;
  console.error(`GATEWAY_READY pid=${process.pid} ${endpoint} pairing=${args.pairing ? 'on' : 'off'}`);

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
