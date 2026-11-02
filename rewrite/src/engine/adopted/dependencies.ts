import type { EngineDeps } from '../index.js';
import type { SourceModelTransports } from './provider-transports.js';
import type { OriginalToolCatalog } from './tool-catalog.js';

/** The historical engine runs source tools itself; it needs no native ToolRegistry. */
export type AdoptedEngineDeps = Omit<EngineDeps, 'models' | 'tools'> & {
  readonly models: SourceModelTransports;
  readonly tools: OriginalToolCatalog;
};
