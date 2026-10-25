import { register } from 'node:module';
register('./dependency-fallback.mjs', import.meta.url);
