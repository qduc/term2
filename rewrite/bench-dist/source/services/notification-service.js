import { getTtyWriter as defaultGetTtyWriter, writeOscSequence } from '../utils/output/tty-osc.js';
const OSC777_TERM_PROGRAMS = new Set(['ghostty', 'wezterm', 'foot', 'warpterminal']);
const OSC777_TERM_EXACT = new Set(['foot']);
const OSC777_TERM_PREFIXES = ['xterm-ghostty', 'foot'];
const OSC9_TERM_PROGRAMS = new Set(['iterm.app', 'wezterm', 'warpterminal']);
const OSC9_TERM_EXACT = new Set(['rio']);
const OSC9_TERM_PREFIXES = ['wezterm', 'rio'];
function supportsOsc777(env = process.env) {
    const termProgram = env.TERM_PROGRAM?.toLowerCase();
    if (termProgram && OSC777_TERM_PROGRAMS.has(termProgram)) {
        return true;
    }
    const term = env.TERM?.toLowerCase();
    if (term) {
        if (OSC777_TERM_EXACT.has(term))
            return true;
        if (OSC777_TERM_PREFIXES.some((prefix) => term.startsWith(prefix))) {
            return true;
        }
    }
    return false;
}
function canUseBell(env = process.env, stream = process.stdout) {
    return Boolean(stream.isTTY && !env.CI);
}
function supportsOsc9(env = process.env) {
    const termProgram = env.TERM_PROGRAM?.toLowerCase();
    if (termProgram && OSC9_TERM_PROGRAMS.has(termProgram)) {
        return true;
    }
    const term = env.TERM?.toLowerCase();
    if (term) {
        if (OSC9_TERM_EXACT.has(term))
            return true;
        if (OSC9_TERM_PREFIXES.some((prefix) => term.startsWith(prefix))) {
            return true;
        }
    }
    return false;
}
function getNotificationMethod(env = process.env, stream = process.stdout) {
    if (env.CI)
        return undefined;
    if (supportsOsc777(env))
        return 'osc777';
    if (supportsOsc9(env))
        return 'osc9';
    if (canUseBell(env, stream))
        return 'bell';
    return undefined;
}
function escapeOsc(value) {
    return value.replace(/\x1b/g, '').replace(/\x07/g, '').replace(/;/g, ',');
}
function buildNotificationSequence(title, message, env = process.env, stream = process.stdout) {
    const method = getNotificationMethod(env, stream);
    if (method === 'osc777') {
        return `\x1b]777;notify;${escapeOsc(title)};${escapeOsc(message)}\x07`;
    }
    if (method === 'osc9') {
        return `\x1b]9;${escapeOsc(message)}\x07`;
    }
    if (method === 'bell') {
        return '\x07';
    }
    return '';
}
function notify(title, message, options = {}) {
    const env = options.env ?? process.env;
    const stream = options.stream ?? process.stdout;
    const method = getNotificationMethod(env, stream);
    if (method === 'osc777') {
        stream.write(`\x1b]777;notify;${escapeOsc(title)};${escapeOsc(message)}\x07`);
        return true;
    }
    if (method === 'osc9') {
        stream.write(`\x1b]9;${escapeOsc(message)}\x07`);
        return true;
    }
    if (method === 'bell') {
        stream.write('\x07');
        return true;
    }
    return false;
}
function sendNotification(title, message, opts = {}) {
    const env = opts.env ?? process.env;
    const logger = opts.logger;
    const stream = opts.stream ?? process.stdout;
    if (logger) {
        logger.debug('sendNotification called', {
            title,
            message,
            termProgram: env.TERM_PROGRAM,
            term: env.TERM,
            supportsOsc777: supportsOsc777(env),
            supportsOsc9: supportsOsc9(env),
            canUseBell: canUseBell(env, stream),
        });
    }
    const getWriter = opts.getTtyWriter ?? defaultGetTtyWriter;
    const writer = getWriter();
    if (!writer)
        return false;
    const sequence = buildNotificationSequence(title, message, env, stream);
    if (!sequence)
        return false;
    if (sequence === '\x07') {
        writer(sequence);
        return true;
    }
    writeOscSequence(sequence, { env, getTtyWriter: () => writer });
    return true;
}
export { notify, supportsOsc777, supportsOsc9, canUseBell, getNotificationMethod, buildNotificationSequence, sendNotification, };
//# sourceMappingURL=notification-service.js.map