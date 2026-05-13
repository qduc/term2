import test from 'ava';
import React from 'react';
import { render } from 'ink-testing-library';
import LiveResponse from '../../dist/components/LiveResponse.js';

const stripAnsi = (s) => s.replaceAll(/\u001B\[[0-9;]*m/g, '');

test('LiveResponse renders streamed text with Markdown formatting', (t) => {
  const { lastFrame } = render(React.createElement(LiveResponse, { text: 'Streaming **Done** text' }));

  const frame = stripAnsi(lastFrame() || '');
  t.true(frame.includes('Streaming'));
  t.true(frame.includes('Done'));
  t.false(frame.includes('**Done**'));
});
