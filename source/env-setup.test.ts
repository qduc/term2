import test from 'ava';
import './env-setup.js';

test('env-setup disables openai agents tracing globally', (t) => {
  t.is(process.env.OPENAI_AGENTS_DISABLE_TRACING, 'true');
});
