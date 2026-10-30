import React from 'react';
import { Box, Text } from 'ink';
import MarkdownRenderer from '../MarkdownRenderer.js';
import Divider from '../common/Divider.js';
import { useTheme } from '../theme.js';
import { useSkin } from '../../skins/SkinContext.js';
const ChatMessage = ({ msg, maxWidth, displayMode = 'standard' }) => {
    const theme = useTheme();
    const { UserMessage, AssistantFrame, assistantGutter } = useSkin();
    // The frame may consume columns on the left; markdown wraps against an explicit width.
    const answerWidth = maxWidth === undefined ? undefined : Math.max(1, maxWidth - assistantGutter);
    return (React.createElement(Box, { flexDirection: "column" }, msg.sender === 'user' && msg.presentation === 'session_rollover' ? (React.createElement(React.Fragment, null,
        React.createElement(Text, { color: theme.reasoning }, "\u21BB Session rollover briefing"),
        React.createElement(MarkdownRenderer, { maxWidth: maxWidth }, msg.text))) : msg.sender === 'user' && msg.presentation === 'server_message' ? (React.createElement(Text, { color: theme.reasoning }, msg.text)) : msg.sender === 'user' ? (React.createElement(UserMessage, { text: msg.text })) : msg.sender === 'system' && msg.presentation === 'rule' ? (React.createElement(Divider, { width: maxWidth })) : msg.sender === 'system' && msg.memoryReceiptCount !== undefined ? (React.createElement(Text, { color: theme.reasoning },
        "Loaded ",
        msg.memoryReceiptCount,
        " ",
        msg.memoryReceiptCount === 1 ? 'memory' : 'memories')) : msg.sender === 'system' ? (React.createElement(Text, { color: theme.reasoning }, displayMode === 'concise' ? msg.conciseText ?? msg.text : msg.text)) : msg.sender === 'reasoning' ? (React.createElement(AssistantFrame, { kind: "reasoning" },
        React.createElement(MarkdownRenderer, { defaultColor: theme.reasoning, maxWidth: answerWidth }, msg.text))) : msg.sender === 'bot' ? (React.createElement(AssistantFrame, { kind: "answer" },
        React.createElement(MarkdownRenderer, { maxWidth: answerWidth }, msg.text))) : null));
};
export default React.memo(ChatMessage);
//# sourceMappingURL=ChatMessage.js.map