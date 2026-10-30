import React, { Component } from 'react';
import { Box, Text } from 'ink';
import { GLYPH_WARNING, useTheme } from './theme.js';
/** The fallback is a function component so it can read the active theme; a class cannot call hooks. */
const ErrorFallback = ({ error, errorInfo }) => {
    const theme = useTheme();
    return (React.createElement(Box, { flexDirection: "column", padding: 1 },
        React.createElement(Box, { marginBottom: 1 },
            React.createElement(Text, { color: theme.danger, bold: true },
                GLYPH_WARNING,
                " Application Error")),
        React.createElement(Box, { marginBottom: 1 },
            React.createElement(Text, null, "A component error occurred and has been logged. The app is still running.")),
        error && (React.createElement(Box, { marginBottom: 1, flexDirection: "column" },
            React.createElement(Text, { color: theme.warning },
                "Error: ",
                error.message),
            error.stack && (React.createElement(Box, { marginTop: 1 },
                React.createElement(Text, { color: theme.textSubtle }, error.stack.split('\n').slice(0, 5).join('\n')))))),
        React.createElement(Box, { marginBottom: 1 },
            React.createElement(Text, { bold: true }, "Recovery options:")),
        React.createElement(Box, { flexDirection: "column", marginLeft: 2 },
            React.createElement(Text, null, "\u2022 Press Ctrl+C twice to quit"),
            React.createElement(Text, null, "\u2022 Restart the application")),
        errorInfo?.componentStack && (React.createElement(Box, { marginTop: 1 },
            React.createElement(Text, { color: theme.textSubtle },
                "Component: ",
                errorInfo.componentStack.split('\n')[1]?.trim())))));
};
/**
 * Error Boundary component to catch render exceptions and prevent app crashes.
 *
 * When a component throws during render:
 * 1. Logs the error via loggingService
 * 2. Shows a minimal fallback UI with recovery instructions
 * 3. Keeps the app running so the user can recover
 */
export class ErrorBoundary extends Component {
    constructor(props) {
        super(props);
        this.state = {
            hasError: false,
            error: null,
            errorInfo: null,
        };
    }
    static getDerivedStateFromError(error) {
        // Update state so the next render will show the fallback UI
        return {
            hasError: true,
            error,
        };
    }
    componentDidCatch(error, errorInfo) {
        // Log the error with full context if logging service is available
        if (this.props.loggingService) {
            this.props.loggingService.error('React component error caught by ErrorBoundary', {
                error: error.message,
                stack: error.stack,
                componentStack: errorInfo.componentStack,
                name: error.name,
            });
        }
        // Store error info in state for display
        this.setState({
            errorInfo,
        });
    }
    render() {
        if (this.state.hasError) {
            const { error, errorInfo } = this.state;
            return React.createElement(ErrorFallback, { error: error, errorInfo: errorInfo });
        }
        return this.props.children;
    }
}
//# sourceMappingURL=ErrorBoundary.js.map