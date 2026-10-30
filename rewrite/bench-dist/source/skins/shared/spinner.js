import { useEffect, useState } from 'react';
/** Braille dots: every frame is one cell wide, and they read as motion at a glance. */
export const BRAILLE_SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
/** A steady, quiet alternative for skins that prefer less motion. */
export const DOT_SPINNER = ['·  ', '·· ', '···', ' ··', '  ·', '   '];
/**
 * The current frame of a spinner, advancing while `active`.
 *
 * It re-renders only the component that calls it, so a skin should call it in the
 * smallest component that shows the glyph (the header of a *running* tool call,
 * the working indicator) and never in a container. When not active it returns the
 * first frame and schedules nothing, so settled output costs no timers.
 */
export function useSpinnerFrame(frames, active = true, intervalMs = 100) {
    const [index, setIndex] = useState(0);
    useEffect(() => {
        if (!active) {
            return undefined;
        }
        const timer = setInterval(() => setIndex((current) => (current + 1) % frames.length), intervalMs);
        return () => clearInterval(timer);
    }, [active, frames.length, intervalMs]);
    return frames[active ? index % frames.length : 0];
}
//# sourceMappingURL=spinner.js.map