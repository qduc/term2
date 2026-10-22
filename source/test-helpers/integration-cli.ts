import { inject } from 'vitest';

declare module 'vitest' {
  export interface ProvidedContext {
    integrationCliPath: string;
  }
}

export function integrationCliPath(): string {
  const cliPath = inject('integrationCliPath');
  if (!cliPath) throw new Error('Integration CLI requires integration-cli-global-setup.ts');
  return cliPath;
}
