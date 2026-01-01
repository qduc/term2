import React, {FC} from 'react';
import {Box, Text} from 'ink';

/**
 * Placeholder for Companion Mode App.
 * This will be implemented in subsequent phases.
 */
interface CompanionAppProps {
// TODO: Add proper props in Phase 2
}

const CompanionApp: FC<CompanionAppProps> = () => {
return (
<Box flexDirection="column" padding={1}>
<Text bold color="yellow">
Companion Mode (Work in Progress)
</Text>
<Text>
Terminal companion mode is not yet fully implemented.
</Text>
<Text dimColor>
This feature will allow the AI to watch your terminal session
</Text>
<Text dimColor>
and assist when needed with ?? queries or !auto commands.
</Text>
</Box>
);
};

export default CompanionApp;
