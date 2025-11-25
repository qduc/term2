import React from 'react';
import {Box, Text} from 'ink';
import {marked} from 'marked';

export default function MarkdownRenderer({children}) {
	const tokens = marked.lexer(children);

	const renderToken = (token, index) => {
		switch (token.type) {
			case 'heading':
				return (
					<Text key={index} bold color="cyan">
						{'#'.repeat(token.depth)} {token.text}
					</Text>
				);

			case 'paragraph':
				return (
					<Box key={index} marginBottom={1}>
						<Text>{renderInlineTokens(token.tokens)}</Text>
					</Box>
				);

			case 'code':
				return (
					<Box key={index} flexDirection="column" marginBottom={1}>
						<Text color="yellow" backgroundColor="black">
							{token.text}
						</Text>
					</Box>
				);

			case 'codespan':
				return (
					<Text key={index} color="yellow">
						{token.text}
					</Text>
				);

			case 'list':
				return (
					<Box
						key={index}
						flexDirection="column"
						marginBottom={1}
						marginLeft={2}
					>
						{token.items.map((item, idx) =>
							renderListItem(item, idx, token.ordered, idx),
						)}
					</Box>
				);

			case 'blockquote':
				return (
					<Box key={index} flexDirection="row" marginBottom={1} marginLeft={2}>
						<Text color="gray" dimColor>
							{'│ '}
						</Text>
						<Box flexDirection="column">
							{token.tokens.map((t, idx) => renderToken(t, idx))}
						</Box>
					</Box>
				);

			case 'hr':
				return (
					<Text key={index} color="gray">
						{'─'.repeat(40)}
					</Text>
				);

			case 'space':
				return <Box key={index} marginBottom={1} />;

			default:
				return null;
		}
	};

	const renderListItem = (item, index, ordered, idx) => {
		// Extract text content from the list item
		const content = item.tokens.map((token, tIdx) => {
			if (token.type === 'text') {
				return (
					<Text key={tIdx}>
						{renderInlineTokens(token.tokens) || token.text}
					</Text>
				);
			}
			if (token.type === 'list') {
				// Handle nested lists
				return (
					<Box key={tIdx} flexDirection="column" marginLeft={2}>
						{token.items.map((nestedItem, nIdx) =>
							renderListItem(nestedItem, nIdx, token.ordered, nIdx),
						)}
					</Box>
				);
			}
			return null;
		});

		return (
			<Box key={index} flexDirection="row">
				<Text>{ordered ? `${idx + 1}. ` : '• '}</Text>
				<Box flexDirection="column">{content}</Box>
			</Box>
		);
	};

	const renderInlineTokens = tokens => {
		if (!tokens) return null;

		return tokens.map((token, idx) => {
			switch (token.type) {
				case 'text':
					return <Text key={idx}>{token.text}</Text>;

				case 'strong':
					return (
						<Text key={idx} bold>
							{renderInlineTokens(token.tokens) || token.text}
						</Text>
					);

				case 'em':
					return (
						<Text key={idx} italic>
							{renderInlineTokens(token.tokens) || token.text}
						</Text>
					);

				case 'codespan':
					return (
						<Text key={idx} color="yellow">
							{token.text}
						</Text>
					);

				case 'link':
					return (
						<Text key={idx} color="blue" underline>
							{token.text}
						</Text>
					);

				default:
					return null;
			}
		});
	};

	return (
		<Box flexDirection="column">
			{tokens.map((token, index) => renderToken(token, index))}
		</Box>
	);
}
