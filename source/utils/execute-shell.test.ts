import test from 'ava';
import {executeShellCommand} from './execute-shell.js';

test('executeShellCommand returns stdout and exit code for successful command', async t => {
    const result = await executeShellCommand(
        "printf 'hello'",
    );

    t.is(result.stdout, 'hello');
    t.is(result.stderr, '');
    t.is(result.exitCode, 0);
    t.false(result.timedOut);
});

test('executeShellCommand captures stderr and exit code for failed command', async t => {
    const result = await executeShellCommand(
        'sh -c "echo oops 1>&2; exit 2"',
    );

    t.is(result.stderr.trim(), 'oops');
    t.is(result.exitCode, 2);
    t.false(result.timedOut);
});

test('executeShellCommand reports timeouts', async t => {
    const result = await executeShellCommand(
        'sh -c "sleep 1"',
        {timeout: 50},
    );

    t.true(result.timedOut);
});
