import type { MenuController, MenuEvent } from './menu-types.js';

/**
 * Apply the editor-shaped part of a menu event. The menu session chooses when
 * this is appropriate; this helper only centralizes the cursor/text mechanics.
 */
export function applyMenuEditorEvent(
  controller: MenuController,
  event: MenuEvent,
  options: { horizontal?: boolean } = {},
): boolean {
  const editor = controller.getSnapshot().editor;

  if (event.type === 'input') {
    if (!event.text) return true;
    controller.applyEditorEdit({ type: 'insert', text: event.text });
    return true;
  }

  if (event.type !== 'command') return false;

  if (event.command === 'backspace') {
    if (editor.cursor > 0) {
      controller.applyEditorEdit({
        type: 'set-text',
        text: editor.text.slice(0, editor.cursor - 1) + editor.text.slice(editor.cursor),
        cursor: editor.cursor - 1,
      });
    }
    return true;
  }

  if (event.command === 'delete') {
    if (editor.cursor < editor.text.length) {
      controller.applyEditorEdit({
        type: 'set-text',
        text: editor.text.slice(0, editor.cursor) + editor.text.slice(editor.cursor + 1),
        cursor: editor.cursor,
      });
    }
    return true;
  }

  if (options.horizontal !== false && event.command === 'left') {
    controller.applyEditorEdit({ type: 'move-cursor', cursor: editor.cursor - 1 });
    return true;
  }

  if (options.horizontal !== false && event.command === 'right') {
    controller.applyEditorEdit({ type: 'move-cursor', cursor: editor.cursor + 1 });
    return true;
  }

  return false;
}
