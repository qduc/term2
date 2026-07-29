import { expectTypeOf, it } from 'vitest';
import type { StreamedModelTurn } from './streamed-model-turn.js';

it('exposes one operation for one streamed model turn', () => {
  expectTypeOf<StreamedModelTurn>().toHaveProperty('stream');
  expectTypeOf<StreamedModelTurn>().not.toHaveProperty('generate');
});
