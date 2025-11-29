import React, {FC} from 'react';
import {Box, Text} from 'ink';

type Props = {
	approval: any;
};

type ApplyPatchArgs = {
	type: 'create_file' | 'update_file' | 'delete_file';
	path: string;
	diff?: string;
};

const operationLabels: Record<string, {label: string; color: string}> = {
	create_file: {label: 'CREATE', color: 'green'},
	update_file: {label: 'UPDATE', color: 'yellow'},
	delete_file: {label: 'DELETE', color: 'red'},
};

const DiffView: FC<{diff: string}> = ({diff}) => {
	const lines = diff.split('\n');
	const maxLines = 30;
	const truncated = lines.length > maxLines;
	const displayLines = truncated ? lines.slice(0, maxLines) : lines;

	return (
		<Box flexDirection="column" marginLeft={2}>
			{displayLines.map((line, i) => {
				let color: string | undefined;
				if (line.startsWith('+')) {
					color = 'green';
				} else if (line.startsWith('-')) {
					color = 'red';
				} else if (line.startsWith('@@')) {
					color = 'cyan';
				}

				return (
					<Text key={i} color={color} dimColor={!color}>
						{line}
					</Text>
				);
			})}
			{truncated && (
				<Text dimColor>... ({lines.length - maxLines} more lines)</Text>
			)}
		</Box>
	);
};

const ApplyPatchPrompt: FC<{args: ApplyPatchArgs}> = ({args}) => {
	const op = operationLabels[args.type] || {label: args.type, color: 'white'};

	return (
		<Box flexDirection="column">
			<Box>
				<Text color={op.color} bold>
					[{op.label}]
				</Text>
				<Text> {args.path}</Text>
			</Box>
			{args.diff && <DiffView diff={args.diff} />}
		</Box>
	);
};

const ApprovalPrompt: FC<Props> = ({approval}) => {
	// Try to parse and render apply_patch arguments nicely
	let content: React.ReactNode = (
		<Text dimColor>{approval.argumentsText}</Text>
	);

	if (approval.toolName === 'apply_patch') {
		try {
			const args: ApplyPatchArgs = JSON.parse(approval.argumentsText);
			content = <ApplyPatchPrompt args={args} />;
		} catch {
			// Fall back to raw JSON if parsing fails
		}
	}

	return (
		<Box flexDirection="column">
			<Text color="yellow">
				{approval.agentName} wants to run:{' '}
				<Text bold>{approval.toolName}</Text>
			</Text>
			{content}
			<Text>
				<Text color="yellow">(y/n)</Text>
			</Text>
		</Box>
	);
};

export default ApprovalPrompt;
