import type { NestedRunDriverFactory } from '../../contracts/nested-run-driver.js';
import { ApplicationRunLoop } from './application-run-loop.js';

/** Each nested invocation owns a fresh loop and its continuation state. */
export const createLegacyNestedRunDriver: NestedRunDriverFactory = (deps) => new ApplicationRunLoop(deps);
