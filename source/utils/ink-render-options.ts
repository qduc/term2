export type InkRenderOptions = {
    incrementalRendering: true;
};

/**
 * Centralize Ink render options so the CLI entrypoint stays small and
 * the behavior is unit-testable.
 */
export function getInkRenderOptions(): InkRenderOptions {
    return {incrementalRendering: true};
}
