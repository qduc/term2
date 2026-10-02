// @ts-expect-error IS_REACT_ACT_ENVIRONMENT is not in globalThis types
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import { describe, expect, it } from 'vitest';
import { SKIN_NAMES } from './names.js';
import { SKINS } from './registry.js';
import { findConformanceProblems } from './testing/conformance.js';
import { SCENES, renderScene } from './testing/scenes.js';
import type { ThemeName } from '../theme/palettes.js';

/**
 * The contract every skin must meet, run against the real containers.
 *
 * A skin is free to draw anything it likes; it is not free to
 *  - emit a line wider than the terminal (a wrapped border is a broken screen),
 *  - drop content the container handed it (a command, an option, an error),
 *  - crash, at any width down to 40 columns, in colour or in `mono`.
 *
 * Colour discipline is enforced separately by `theme/no-raw-colors.guard.test.ts`,
 * contrast by `theme/palettes.test.ts`; that these checks can actually fail is
 * proved by `testing/conformance.test.ts`.
 */

const WIDTHS = [40, 60, 80, 120] as const;
/** `dark` is the reference palette; `mono` proves the layout carries meaning without colour. */
const THEMES_UNDER_TEST: readonly ThemeName[] = ['dark', 'mono'];

describe('skin registry', () => {
  it('registers exactly the skins that ui.skin accepts, each under its own name', () => {
    expect(Object.keys(SKINS).sort()).toEqual([...SKIN_NAMES].sort());
    for (const name of SKIN_NAMES) {
      expect(SKINS[name].name).toBe(name);
    }
  });

  it('gives every skin every slot', () => {
    const slots = Object.keys(SKINS.classic).sort();
    for (const name of SKIN_NAMES) {
      expect(Object.keys(SKINS[name]).sort(), name).toEqual(slots);
    }
  });
});

describe.each(SKIN_NAMES)('%s skin', (skin) => {
  describe.each(SCENES)('$id', (scene) => {
    describe.each(THEMES_UNDER_TEST)('%s theme', (theme) => {
      it.each(WIDTHS)('fits and keeps its content at %i columns', (columns) => {
        expect(findConformanceProblems(renderScene(scene, { skin, theme, columns }), scene, columns)).toEqual([]);
      });
    });
  });
});
