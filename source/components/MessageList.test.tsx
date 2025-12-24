import test from 'ava';
import React from 'react';
import {render} from 'ink-testing-library';
import MessageList from './MessageList.js';

test('MessageList renders user and bot messages', t => {
    const messages = [
        {id: 1, sender: 'user', text: 'hello'},
        {id: 2, sender: 'bot', text: 'hi there'},
    ];
    const {lastFrame} = render(<MessageList messages={messages} />);
    const output = lastFrame() ?? '';
    t.true(output.includes('❯ hello'));
    t.true(output.includes('hi there'));
});
