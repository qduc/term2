#!/usr/bin/env node
import { Term2Gateway, type GatewayLaunchConfig } from './gateway.js';

/**
 * Deployment launcher seam. Production provisioning supplies this configuration
 * from a secret/configuration manager; there are deliberately no insecure defaults.
 */
export async function launchGateway(config: GatewayLaunchConfig): Promise<Term2Gateway> {
  const gateway = Term2Gateway.create(config);
  const stop = async () => {
    await gateway.shutdown();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  await gateway.start();
  return gateway;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  throw new Error('gateway launcher requires explicit platform configuration');
}
