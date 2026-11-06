import { inject } from 'vitest';

declare module 'vitest' {
  export interface ProvidedContext {
    testNodeCompileCache: string;
  }
}

const cache = inject('testNodeCompileCache');
if (cache) {
  process.env.TERM2_TEST_NODE_COMPILE_CACHE = cache;
  process.env.NODE_COMPILE_CACHE = cache;
}
