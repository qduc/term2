import { stdout } from 'node:process';
import {
  setProjectListenerApproval,
  setProjectNetworkApproval,
} from '../../tools/shell/sandbox/sandbox-network-store.js';
import { isSandboxNetworkHost, isSandboxNetworkPort } from '../../tools/shell/sandbox/sandbox-network-validation.js';
import { UsageError } from '../cli-args.js';

export function runSandboxNetworkCommand(argv: readonly string[]): number {
  const [action, host, portText] = argv;
  if (action === 'listen' && argv.length === 2 && (host === 'allow' || host === 'revoke')) {
    setProjectListenerApproval(process.cwd(), host === 'allow');
    stdout.write(
      host === 'allow'
        ? 'Sandbox listener approval granted for this project. Wildcard binds may expose services to your LAN.\n'
        : 'Sandbox listener approval revoked for this project.\n',
    );
    return 0;
  }
  const port = Number(portText);
  if (
    argv.length !== 3 ||
    (action !== 'allow' && action !== 'revoke') ||
    !isSandboxNetworkHost(host) ||
    !/^\d+$/.test(portText ?? '') ||
    !isSandboxNetworkPort(port)
  )
    throw new UsageError(
      'Usage: term2 sandbox-network <allow|revoke> <host> <port> or term2 sandbox-network listen <allow|revoke>',
    );
  setProjectNetworkApproval(process.cwd(), host, port, action === 'allow');
  stdout.write(
    `Sandbox network approval ${action === 'allow' ? 'granted' : 'revoked'} for ${host}:${port} in this project.\n`,
  );
  return 0;
}
