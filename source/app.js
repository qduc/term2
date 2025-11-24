import React, {useState} from 'react';
import {Box, Text, Newline} from 'ink';
import TextInput from 'ink-text-input';

export default function App() {
	const [messages, setMessages] = useState([
		{id: 1, sender: 'bot', text: 'Hello! I am a fake bot. Ask me anything.'},
	]);
	const [input, setInput] = useState('');

	const handleSubmit = value => {
		if (!value.trim()) return;

		const userMessage = {
			id: Date.now(),
			sender: 'user',
			text: value,
		};

		setMessages(prev => [...prev, userMessage]);
		setInput('');

		// Fake bot response
		setTimeout(() => {
			const botMessage = {
				id: Date.now() + 1,
				sender: 'bot',
				text: `Fake answer to: "${value}"`,
			};
			setMessages(prev => [...prev, botMessage]);
		}, 1000);
	};

	return (
		<Box flexDirection="column">
			<Box flexDirection="column" marginBottom={1}>
				{messages.map(msg => (
					<Box key={msg.id}>
						<Text color={msg.sender === 'user' ? 'blue' : 'green'}>
							{msg.sender === 'user' ? 'You: ' : 'Bot: '}
						</Text>
						<Text>{msg.text}</Text>
					</Box>
				))}
			</Box>

			<Box>
				<Text color="blue">You: </Text>
				<TextInput
					value={input}
					onChange={setInput}
					onSubmit={handleSubmit}
				/>
			</Box>
		</Box>
	);
}
