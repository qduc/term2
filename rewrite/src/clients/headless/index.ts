/**
 * Renders one turn. Structural types only, because clients may not import
 * session/ or engine/.
 *
 * `{ type: string }` keeps the union open, so a discriminant check does not
 * narrow it; use `'delta' in event` or `'result' in event`.
 */

export type HeadlessEvent =
  | { readonly type: 'text_delta'; readonly delta: string }
  | {
      readonly type: 'turn_ended';
      readonly result: { readonly kind: string; readonly error?: { readonly message: string } };
    }
  | { readonly type: string };

export type HeadlessIo = {
  readonly stdout: { write(text: string): unknown };
  readonly stderr: { write(text: string): unknown };
};

export function renderTurn(_events: AsyncIterable<HeadlessEvent>, _io: HeadlessIo): Promise<{ readonly kind: string }> {
  throw new Error('renderTurn is not implemented yet (M1 task 3)');
}
