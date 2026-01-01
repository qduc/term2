import test from 'ava';
import {EventDetector, type DetectedEvent} from './event-detector.js';
import type {CommandEntry} from './context-buffer.js';

// Helper to create a test entry
function createEntry(
    command: string,
    exitCode = 0,
    output = '',
): CommandEntry {
    return {
        command,
        output,
        exitCode,
        timestamp: Date.now(),
        outputLines: output.split('\n').length,
    };
}

test('does not trigger on first failure', t => {
    const detector = new EventDetector({errorCascadeThreshold: 3});

    const result = detector.processCommand(createEntry('cmd', 1));

    t.is(result, null);
});

test('triggers error_cascade after threshold consecutive failures', t => {
    const detector = new EventDetector({errorCascadeThreshold: 3});

    detector.processCommand(createEntry('cmd1', 1));
    detector.processCommand(createEntry('cmd2', 1));
    const result = detector.processCommand(createEntry('cmd3', 1));

    t.not(result, null);
    t.is(result?.pattern, 'error_cascade');
    t.truthy(result?.message);
});

test('error cascade resets after success', t => {
    const detector = new EventDetector({errorCascadeThreshold: 3});

    detector.processCommand(createEntry('cmd1', 1));
    detector.processCommand(createEntry('cmd2', 1));
    detector.processCommand(createEntry('success', 0)); // Reset
    detector.processCommand(createEntry('cmd3', 1));
    const result = detector.processCommand(createEntry('cmd4', 1));

    t.is(result, null);
});

test('does not trigger retry_loop on first occurrence', t => {
    const detector = new EventDetector({retryLoopThreshold: 2});

    const result = detector.processCommand(createEntry('npm test'));

    t.is(result, null);
});

test('triggers retry_loop when same command repeated', t => {
    const detector = new EventDetector({retryLoopThreshold: 2});

    detector.processCommand(createEntry('npm test'));
    const result = detector.processCommand(createEntry('npm test'));

    t.not(result, null);
    t.is(result?.pattern, 'retry_loop');
    t.truthy(result?.message);
});

test('retry loop resets with different command', t => {
    const detector = new EventDetector({retryLoopThreshold: 2});

    detector.processCommand(createEntry('npm test'));
    detector.processCommand(createEntry('git status')); // Different
    const result = detector.processCommand(createEntry('npm test'));

    t.is(result, null);
});

test('markActivity resets activity timer', t => {
    const detector = new EventDetector();

    detector.markActivity();

    t.true(detector.timeSinceLastActivity < 100); // Should be very recent
});

test('getOptions returns current options', t => {
    const detector = new EventDetector({errorCascadeThreshold: 5});

    const options = detector.getOptions();

    t.is(options.errorCascadeThreshold, 5);
});

test('setOptions updates options', t => {
    const detector = new EventDetector({errorCascadeThreshold: 3});

    detector.setOptions({errorCascadeThreshold: 5});

    t.is(detector.getOptions().errorCascadeThreshold, 5);
});

test('setOptions preserves unset options', t => {
    const detector = new EventDetector({
        errorCascadeThreshold: 3,
        retryLoopThreshold: 2,
    });

    detector.setOptions({errorCascadeThreshold: 5});

    t.is(detector.getOptions().retryLoopThreshold, 2);
});

test('clear resets all state', t => {
    const detector = new EventDetector({errorCascadeThreshold: 2});

    detector.processCommand(createEntry('cmd', 1));
    detector.clear();
    const result = detector.processCommand(createEntry('cmd', 1));

    t.is(result, null); // Cascade count should be reset
});

test('emits hint event for long_pause', async t => {
    const detector = new EventDetector({pauseHintDelayMs: 50});
    const events: DetectedEvent[] = [];

    detector.on('hint', (event: DetectedEvent) => {
        events.push(event);
    });

    // Trigger an error
    detector.processCommand(createEntry('cmd', 1));

    // Wait for pause hint
    await new Promise(resolve => setTimeout(resolve, 100));

    t.is(events.length, 1);
    t.is(events[0]?.pattern, 'long_pause');
});

test('pause hint is cancelled by new activity', async t => {
    const detector = new EventDetector({pauseHintDelayMs: 100});
    const events: DetectedEvent[] = [];

    detector.on('hint', (event: DetectedEvent) => {
        events.push(event);
    });

    // Trigger an error
    detector.processCommand(createEntry('cmd', 1));

    // Add activity before pause triggers
    await new Promise(resolve => setTimeout(resolve, 50));
    detector.markActivity();

    // Wait past original pause time
    await new Promise(resolve => setTimeout(resolve, 100));

    t.is(events.length, 0);
});

test('uses default options when not provided', t => {
    const detector = new EventDetector();
    const options = detector.getOptions();

    t.is(options.errorCascadeThreshold, 3);
    t.is(options.retryLoopThreshold, 2);
    t.is(options.pauseHintDelayMs, 30000);
});
