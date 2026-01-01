/**
 * Companion Mode - Terminal Companion that observes, learns, and assists.
 *
 * Instead of the AI being the primary interface, the user's normal terminal remains primary.
 * The AI watches silently in the background, building context from commands and outputs.
 * When the user gets stuck or explicitly asks, the AI can assist or temporarily take control.
 */

export {CompanionApp} from './companion-app.js';
export type {CompanionAppProps} from './companion-app.js';

export {PTYWrapper} from './pty-wrapper.js';
export type {PTYWrapperOptions, PTYWrapperEvents} from './pty-wrapper.js';

export {ContextBuffer} from './context-buffer.js';
export type {
    CommandEntry,
    CommandIndexEntry,
    ContextBufferOptions,
} from './context-buffer.js';

export {ModeManager} from './mode-manager.js';
export type {CompanionMode} from './mode-manager.js';

export {EventDetector} from './event-detector.js';
export type {
    EventPattern,
    EventDetectorOptions,
    DetectedEvent,
} from './event-detector.js';

export {Summarizer} from './summarizer.js';
export type {SummarizerDeps} from './summarizer.js';

export {createTerminalHistoryToolDefinition} from './terminal-history.js';
export type {TerminalHistoryParams} from './terminal-history.js';

export {formatCommandIndex, generateCommandIndexPrompt, estimateTokens} from './command-index.js';

export {
    classifyOutputType,
    shouldSummarize,
    getSummarizationPrompt,
} from './output-classifier.js';
export type {OutputType} from './output-classifier.js';

export {StatusBar} from './components/status-bar.js';
export type {StatusBarProps} from './components/status-bar.js';

export {
    parseCompanionInput,
    isShellPrompt,
    extractCommandFromPromptLine,
    CommandOutputBuffer,
} from './input-parser.js';
export type {ParsedInput} from './input-parser.js';

export {CompanionSession} from './companion-session.js';
export type {CompanionSessionDeps, CompanionEvent} from './companion-session.js';

export {
    classifyCommandSafety,
    shouldAutoApprove,
    shouldBlock,
    getSafetyDescription,
} from './safety-classifier.js';
export type {SafetyLevel, SafetyClassification} from './safety-classifier.js';
