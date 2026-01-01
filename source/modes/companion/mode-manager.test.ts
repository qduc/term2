import test from 'ava';
import {ModeManager, type CompanionMode} from './mode-manager.js';

test('starts in watch mode by default', t => {
    const manager = new ModeManager();
    t.is(manager.mode, 'watch');
    t.true(manager.isWatchMode);
    t.false(manager.isAutoMode);
});

test('setMode changes the current mode', t => {
    const manager = new ModeManager();

    manager.setMode('auto');

    t.is(manager.mode, 'auto');
    t.false(manager.isWatchMode);
    t.true(manager.isAutoMode);
});

test('enterWatchMode sets mode to watch', t => {
    const manager = new ModeManager();
    manager.setMode('auto');

    manager.enterWatchMode();

    t.is(manager.mode, 'watch');
});

test('enterAutoMode sets mode to auto', t => {
    const manager = new ModeManager();

    manager.enterAutoMode();

    t.is(manager.mode, 'auto');
});

test('emits modeChange event on mode change', t => {
    const manager = new ModeManager();
    const events: {mode: CompanionMode; previousMode: CompanionMode}[] = [];

    manager.on('modeChange', (mode, previousMode) => {
        events.push({mode, previousMode});
    });

    manager.setMode('auto');
    manager.setMode('watch');

    t.is(events.length, 2);
    t.deepEqual(events[0], {mode: 'auto', previousMode: 'watch'});
    t.deepEqual(events[1], {mode: 'watch', previousMode: 'auto'});
});

test('does not emit modeChange when mode is the same', t => {
    const manager = new ModeManager();
    let eventCount = 0;

    manager.on('modeChange', () => {
        eventCount++;
    });

    manager.setMode('watch'); // Same as current

    t.is(eventCount, 0);
});

test('reset returns to watch mode', t => {
    const manager = new ModeManager();
    manager.setMode('auto');

    manager.reset();

    t.is(manager.mode, 'watch');
});

test('reset does not emit event', t => {
    const manager = new ModeManager();
    let eventCount = 0;
    manager.setMode('auto');

    manager.on('modeChange', () => {
        eventCount++;
    });

    manager.reset();

    // reset() directly sets the mode without emitting
    t.is(eventCount, 0);
});
