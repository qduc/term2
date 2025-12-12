import React, {Component, ReactNode} from 'react';
import {Box, Text} from 'ink';
import {loggingService} from '../services/logging-service.js';

interface ErrorBoundaryProps {
	children: ReactNode;
}

interface ErrorBoundaryState {
	hasError: boolean;
	error: Error | null;
	errorInfo: React.ErrorInfo | null;
}

/**
 * Error Boundary component to catch render exceptions and prevent app crashes.
 *
 * When a component throws during render:
 * 1. Logs the error via loggingService
 * 2. Shows a minimal fallback UI with recovery instructions
 * 3. Keeps the app running so the user can recover
 */
export class ErrorBoundary extends Component<
	ErrorBoundaryProps,
	ErrorBoundaryState
> {
	constructor(props: ErrorBoundaryProps) {
		super(props);
		this.state = {
			hasError: false,
			error: null,
			errorInfo: null,
		};
	}

	static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
		// Update state so the next render will show the fallback UI
		return {
			hasError: true,
			error,
		};
	}

	componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
		// Log the error with full context
		loggingService.error('React component error caught by ErrorBoundary', {
			error: error.message,
			stack: error.stack,
			componentStack: errorInfo.componentStack,
			name: error.name,
		});

		// Store error info in state for display
		this.setState({
			errorInfo,
		});
	}

	render(): ReactNode {
		if (this.state.hasError) {
			const {error, errorInfo} = this.state;

			return (
				<Box flexDirection="column" padding={1}>
					<Box marginBottom={1}>
						<Text color="red" bold>
							⚠ Application Error
						</Text>
					</Box>

					<Box marginBottom={1}>
						<Text>
							A component error occurred and has been logged. The app is still
							running.
						</Text>
					</Box>

					{error && (
						<Box marginBottom={1} flexDirection="column">
							<Text color="yellow">Error: {error.message}</Text>
							{error.stack && (
								<Box marginTop={1}>
									<Text dimColor>{error.stack.split('\n').slice(0, 5).join('\n')}</Text>
								</Box>
							)}
						</Box>
					)}

					<Box marginBottom={1}>
						<Text bold>Recovery options:</Text>
					</Box>

					<Box flexDirection="column" marginLeft={2}>
						<Text>• Type /clear to start a new conversation</Text>
						<Text>• Type /quit to exit</Text>
						<Text>• Press Ctrl+C to force quit</Text>
						<Text>• Restart the application</Text>
					</Box>

					{errorInfo?.componentStack && (
						<Box marginTop={1}>
							<Text dimColor>
								Component: {errorInfo.componentStack.split('\n')[1]?.trim()}
							</Text>
						</Box>
					)}
				</Box>
			);
		}

		return this.props.children;
	}
}
