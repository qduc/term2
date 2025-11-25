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
					<Box key={index} flexDirection="column" marginBottom={0.5}>
						{renderInlineTokens(token.tokens)}
					</Box>
				);

			case 'code':
				return (
					<Box key={index} flexDirection="column" marginBottom={0.5}>
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
					<Box key={index} flexDirection="column" marginBottom={0.5} marginLeft={2}>
						{token.items.map((item, idx) => (
							<Box key={idx} marginBottom={0.25}>
								<Text>{token.ordered ? `${idx + 1}. ` : '• '}</Text>
								<Box flexDirection="column">
									{renderInlineTokens(item.tokens)}
								</Box>
							</Box>
						))}
					</Box>
				);

			case 'blockquote':
				return (
					<Box key={index} flexDirection="column" marginBottom={0.5} marginLeft={2}>
						<Text color="gray" dimColor>
							{'│ '}
						</Text>
						{renderInlineTokens(token.tokens)}
					</Box>
				);

			case 'hr':
				return (
					<Text key={index} color="gray">
						{'─'.repeat(40)}
					</Text>
				);

			case 'space':
				return <Box key={index} marginBottom={0.5} />;

			default:
				return null;
		}
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
							{token.text}
						</Text>
					);

				case 'em':
					return (
						<Text key={idx} italic>
							{token.text}
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
