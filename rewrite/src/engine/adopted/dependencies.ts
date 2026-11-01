import type { EngineDeps } from '../index.js';
import type { AdoptedModelRegistry } from '../../model/adopted/index.js';
import type { OriginalToolCatalog } from './tool-catalog.js';

/** The historical engine runs source tools itself; it needs no native ToolRegistry. */
export type AdoptedEngineDeps = Omit<EngineDeps, 'models' | 'tools'> & {
  readonly models: AdoptedModelRegistry;
  readonly tools: OriginalToolCatalog;
};
