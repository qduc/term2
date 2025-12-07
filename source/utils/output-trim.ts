/**
 * Configuration for output trimming limits.
 * Output will be trimmed if it exceeds either limit.
 */
export interface OutputTrimConfig {
    /** Maximum number of lines before trimming (default: 1000) */
    maxLines: number;
    /** Maximum size in characters before trimming (default: 10000) */
    maxCharacters: number;
}

/** Default trim configuration */
export const DEFAULT_TRIM_CONFIG: OutputTrimConfig = {
    maxLines: 1000,
    maxCharacters: 10000,
};

/** Current trim configuration (can be modified at runtime) */
let trimConfig: OutputTrimConfig = {...DEFAULT_TRIM_CONFIG};

/**
 * Set the output trim configuration.
 */
export function setTrimConfig(config: Partial<OutputTrimConfig>): void {
    trimConfig = {...trimConfig, ...config};
}

/**
 * Get the current trim configuration.
 */
export function getTrimConfig(): OutputTrimConfig {
    return {...trimConfig};
}

/**
 * Trims output if it exceeds configured line or character limits.
 * Keeps 40% at the beginning, 40% at the end, and trims 20% from the middle.
 *
 * @param output - The output string to trim
 * @param maxLines - Optional override for maximum lines (uses trimConfig.maxLines if not provided)
 * @param maxCharacters - Optional override for maximum characters (uses trimConfig.maxCharacters if not provided)
 * @returns The trimmed output string with a message indicating how many lines were trimmed
 */
export function trimOutput(
    output: string,
    maxLines?: number,
    maxCharacters?: number,
): string {
    const lines = output.split('\n');
    const charLength = output.length;

    // Use provided overrides or fall back to trimConfig
    const effectiveMaxLines = maxLines ?? trimConfig.maxLines;
    const effectiveMaxCharacters = maxCharacters ?? trimConfig.maxCharacters;

    const exceedsLines = lines.length > effectiveMaxLines;
    const exceedsCharacters = charLength > effectiveMaxCharacters;

    if (!exceedsLines && !exceedsCharacters) {
        return output;
    }

    // Special case: single very long line that exceeds character limit
    if (lines.length === 1 && exceedsCharacters) {
        const keepChars = Math.floor(effectiveMaxCharacters * 0.4);
        const head = output.slice(0, keepChars);
        const tail = output.slice(-keepChars);
        const trimmedChars = output.length - keepChars * 2;
        return `${head}\n... [${trimmedChars} characters trimmed] ...\n${tail}`;
    }

    // Calculate how many lines to keep at beginning and end
    // Keep 40% at the beginning, 40% at the end, trim 20% from the middle
    const keepLines = Math.floor(effectiveMaxLines * 0.4);

    // If exceeds characters but not lines, calculate lines to keep based on character limit
    let effectiveKeepLines = keepLines;
    if (exceedsCharacters && !exceedsLines) {
        // Estimate average characters per line and calculate how many lines fit
        const avgCharsPerLine = charLength / lines.length;
        const maxLinesForChars = Math.floor(
            effectiveMaxCharacters / avgCharsPerLine,
        );
        effectiveKeepLines = Math.floor(maxLinesForChars * 0.4);
    }

    // Ensure we keep at least some lines
    effectiveKeepLines = Math.max(effectiveKeepLines, 10);

    if (lines.length <= effectiveKeepLines * 2) {
        // Not enough lines to meaningfully trim
        return output;
    }

    const headLines = lines.slice(0, effectiveKeepLines);
    const tailLines = lines.slice(-effectiveKeepLines);
    const trimmedCount = lines.length - effectiveKeepLines * 2;

    const trimMessage = `\n... [${trimmedCount} lines trimmed] ...\n`;

    return headLines.join('\n') + trimMessage + tailLines.join('\n');
}
