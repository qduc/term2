import { ApplicationRunLoop } from './application-run-loop.js';
/** Each nested invocation owns a fresh loop and its continuation state. */
export const createLegacyNestedRunDriver = (deps) => new ApplicationRunLoop(deps);
//# sourceMappingURL=legacy-nested-driver.js.map