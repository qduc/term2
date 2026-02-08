import type {OpenAIAgentClient} from './lib/openai-agent-client.js';
import type {ILoggingService} from './services/service-interfaces.js';
import {ConversationSession} from './services/conversation-session.js';
import type {ConversationEvent} from './services/conversation-events.js';

export interface NonInteractiveConfig {
    prompt: string;
    autoApprove: boolean;
    stdout?: NodeJS.WritableStream;
    stderr?: NodeJS.WritableStream;
}

export const NON_INTERACTIVE_REJECTION_REASON =
    'Non-interactive mode: use --auto-approve to allow tool execution';

export interface ConversationSessionLike {
    sendMessage: ConversationSession['sendMessage'];
    handleApprovalDecision: ConversationSession['handleApprovalDecision'];
}

const safePreview = (value: unknown, maxLen = 500): string => {
    try {
        if (typeof value === 'string') {
            return value.length > maxLen ? value.slice(0, maxLen) + '…' : value;
        }
        const json = JSON.stringify(value);
        if (!json) {
            return '';
        }
        return json.length > maxLen ? json.slice(0, maxLen) + '…' : json;
    } catch {
        return '';
    }
};

const formatEventForStderr = (event: ConversationEvent): string | null => {
    switch (event.type) {
        case 'tool_started':
            return `tool_started ${event.toolName} ${safePreview(event.arguments)}\n`;
        case 'command_message':
            return `command_message ${event.message.status} ${event.message.command}\n`;
        case 'approval_required':
            return `approval_required ${event.approval.toolName}\n`;
        case 'retry':
            return `retry ${event.toolName} ${event.attempt}/${event.maxRetries}: ${event.errorMessage}\n`;
        case 'error':
            return `error ${event.message}\n`;
        default:
            return null;
    }
};

export async function runWithSession(
    session: ConversationSessionLike,
    config: NonInteractiveConfig,
): Promise<number> {
    const stdout = config.stdout ?? process.stdout;
    const stderr = config.stderr ?? process.stderr;

    const onEvent = (event: ConversationEvent) => {
        if (event.type === 'text_delta') {
            stdout.write(event.delta);
            return;
        }

        const line = formatEventForStderr(event);
        if (line) {
            stderr.write(line);
        }
    };

    if (config.autoApprove) {
        stderr.write(
            'Warning: --auto-approve enabled. Tools may run without prompting.\n',
        );
    }

    try {
        type SendResult = Awaited<
            ReturnType<ConversationSessionLike['sendMessage']>
        >;
        type ApprovalResult = Awaited<
            ReturnType<ConversationSessionLike['handleApprovalDecision']>
        >;

        let result: SendResult | ApprovalResult = await session.sendMessage(
            config.prompt,
            {onEvent} as any,
        );

        while (result?.type === 'approval_required') {
            if (config.autoApprove) {
                result = await session.handleApprovalDecision('y', undefined, {
                    onEvent,
                } as any);
            } else {
                result = await session.handleApprovalDecision(
                    'n',
                    NON_INTERACTIVE_REJECTION_REASON,
                    {onEvent} as any,
                );
            }

            if (result === null) {
                stderr.write(
                    'error No pending approval context (unexpected in non-interactive mode).\n',
                );
                return 1;
            }
        }

        if (result?.type === 'response') {
            stdout.write('\n');
            return 0;
        }

        stderr.write('error Unexpected conversation result.\n');
        return 1;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        stderr.write(`error ${message}\n`);
        return 1;
    }
}

export async function runNonInteractive(
    config: NonInteractiveConfig & {
        agentClient: OpenAIAgentClient;
        logger: ILoggingService;
    },
): Promise<number> {
    const session = new ConversationSession('non-interactive', {
        agentClient: config.agentClient,
        deps: {logger: config.logger},
    });

    return runWithSession(session, config);
}
