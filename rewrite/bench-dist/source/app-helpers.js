import { getSerializedInputBytes } from './services/large-uncached-input-guard.js';
export const estimateLastTurnTokens = (turn) => {
    const images = turn.images ?? [];
    let inputItem;
    if (images.length === 0) {
        inputItem = turn.text ?? '';
    }
    else {
        const content = [];
        if (turn.text) {
            content.push({ type: 'input_text', text: turn.text });
        }
        for (const image of images) {
            content.push({
                type: 'input_image',
                image: `data:${image.mimeType};base64,${image.data}`,
                detail: 'auto',
            });
        }
        inputItem = { role: 'user', type: 'message', content };
    }
    const bytes = getSerializedInputBytes(inputItem);
    return Math.ceil(bytes / 4);
};
export const appendStartupBannerId = (ids) => [...ids, `startup-banner-${ids.length}`];
export const messagesHaveNonSystemContent = (messages) => messages.some((msg) => msg.sender !== 'system');
export const TERMINAL_REDRAW_CLEAR = '\u001B[2J\u001B[3J\u001B[H';
/** Clear visible screen only (preserves scrollback) — used for automatic resize redraws. */
const TERMINAL_REDRAW_VISIBLE = '\u001B[2J\u001B[H';
export const clearTerminalForRedraw = (stdout) => {
    stdout.write(TERMINAL_REDRAW_CLEAR);
};
/** Clear only the visible screen (preserves scrollback) for automatic resize redraws. */
export const clearVisibleForResize = (stdout) => {
    stdout.write(TERMINAL_REDRAW_VISIBLE);
};
export const scheduleExitSideEffects = (_messages, onExitUsage, schedule = setTimeout) => {
    schedule(() => {
        onExitUsage?.();
    }, 0);
};
//# sourceMappingURL=app-helpers.js.map