import React from 'react';
import {Box, Text, Newline} from 'ink';
import {marked} from 'marked';

// --- Token Renderers ---

// recursively render inline content (bold, italic, links, etc.)
const InlineContent = ({tokens}: {tokens: any[]}) => {
	if (!tokens) return null;

	return (
		<>
			{tokens.map((token, index) => {
				const key = `${token.type}-${index}`;

				switch (token.type) {
					case 'text':
					case 'escape':
						// Handle nested formatting inside text tokens if marked provides them
						if (token.tokens) {
							return <InlineContent key={key} tokens={token.tokens} />;
						}
						return <Text key={key}>{token.text}</Text>;

					case 'strong':
						return (
							<Text key={key} bold>
								<InlineContent tokens={token.tokens} />
							</Text>
						);

					case 'em':
						return (
							<Text key={key} italic>
								<InlineContent tokens={token.tokens} />
							</Text>
						);

					case 'codespan':
						return (
							<Text key={key} color="yellow" backgroundColor="#333">
								{` ${token.text} `}
							</Text>
						);

					case 'link':
						return (
							<Text key={key} color="blue" underline>
								{token.text}
							</Text>
						);

					case 'image':
						return (
							<Text key={key} color="gray">
								{' '}
								[Image: {token.text}]{' '}
							</Text>
						);

					case 'br':
						return <Newline key={key} />;

					default:
						return <Text key={key}>{token.raw}</Text>;
				}
			})}
		</>
	);
};

// Render Block elements (Headings, Paragraphs, Lists)
const BlockRenderer = ({token}: {token: any}) => {
	switch (token.type) {
		case 'heading':
			const isMain = token.depth === 1;
			return (
				<Box flexDirection="column" marginTop={1} marginBottom={1}>
					<Text bold underline={isMain} color={isMain ? 'green' : 'cyan'}>
						{isMain ? '# ' : '## '}
						<InlineContent tokens={token.tokens} />
					</Text>
				</Box>
			);

		case 'paragraph':
			return (
				<Box marginBottom={1}>
					<Text>
						<InlineContent tokens={token.tokens} />
					</Text>
				</Box>
			);

		case 'list':
			return (
				<Box flexDirection="column" marginBottom={1}>
					{token.items.map((item: any, index: number) => (
						<BlockRenderer key={index} token={item} />
					))}
				</Box>
			);

		case 'list_item':
			return (
				<Box flexDirection="row">
					<Box marginRight={1}>
						<Text color="green">•</Text>
					</Box>
					<Box flexDirection="column">
						{/* List items can contain multiple block tokens (like sub-lists or paragraphs) */}
						{token.tokens.map((subToken: any, i: number) => {
							// If it's just text inside the list item, marked might wrap it in a generic block
							if (subToken.type === 'text') {
								return (
									<Text key={i}>
										<InlineContent tokens={subToken.tokens} />
									</Text>
								);
							}
							return <BlockRenderer key={i} token={subToken} />;
						})}
					</Box>
				</Box>
			);

		case 'code':
			return (
				<Box
					borderStyle="round"
					borderColor="gray"
					paddingX={1}
					marginBottom={1}
					flexDirection="column"
				>
					<Text color="yellow">{token.text}</Text>
				</Box>
			);

		case 'blockquote':
			return (
				<Box
					paddingLeft={2}
					borderStyle="classic"
					borderLeft
					borderRight={false}
					borderTop={false}
					borderBottom={false}
					borderColor="magenta"
					marginBottom={1}
				>
					<Text italic dimColor>
						{/* Blockquotes often contain nested paragraphs */}
						{token.tokens.map((t: any, i: number) => (
							<BlockRenderer key={i} token={t} />
						))}
					</Text>
				</Box>
			);

		case 'space':
			return null;

		case 'hr':
			return (
				<Box marginY={1}>
					<Text color="gray">────────────────────────────────────────</Text>
				</Box>
			);

		default:
			// Fallback for unknown blocks
			// console.log(`Unknown token type: ${token.type}`);
			return null;
	}
};

// --- Main Component ---

interface MarkdownRendererProps {
	children?: React.ReactNode;
	tokens?: any[];
}

const MarkdownRenderer = ({children, tokens}: MarkdownRendererProps) => {
	// Allow passing raw text (which we parse) OR pre-parsed tokens
	const ast = tokens || marked.lexer(String(children || ''));

	return (
		<Box flexDirection="column">
			{ast.map((token: any, index: number) => (
				<BlockRenderer key={index} token={token} />
			))}
		</Box>
	);
};

export default MarkdownRenderer;
