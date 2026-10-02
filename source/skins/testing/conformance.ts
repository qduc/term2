import { stripVTControlCharacters } from 'node:util';
import type { Scene } from './scenes.js';

const visibleWidth = (line: string): number => Array.from(line).length;

/** Box-drawing and gutter characters a skin may put between the words of a wrapped phrase. */
const DECORATION = /[│┃║╎┆▏▌▍┌┐└┘├┤╭╮╯╰─━]/g;

/**
 * Everything wrong with one rendered scene, as human-readable findings (empty when
 * it conforms): nothing rendered, a line wider than the terminal, or content the
 * container supplied that is no longer visible.
 */
export function findConformanceProblems(rawFrame: string, scene: Scene, columns: number): string[] {
  const frame = stripVTControlCharacters(rawFrame);
  const problems: string[] = [];

  if (frame.trim().length === 0) {
    return ['rendered nothing'];
  }

  frame.split('\n').forEach((line, index) => {
    const width = visibleWidth(line);
    if (width > columns) {
      problems.push(`line ${index + 1} is ${width} columns wide, over the ${columns} available: ${line}`);
    }
  });

  if (columns >= (scene.contentFromColumns ?? 0)) {
    // A narrow terminal may wrap a phrase across lines and borders, so compare on the
    // words, ignoring line breaks and the decoration between them.
    const words = frame.replace(DECORATION, ' ').replace(/\s+/g, ' ');
    for (const expected of scene.mustContain) {
      if (!words.includes(expected.replace(/\s+/g, ' '))) {
        problems.push(`${scene.id} no longer shows ${JSON.stringify(expected)}`);
      }
    }
  }

  return problems;
}
