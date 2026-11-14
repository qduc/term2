import { sanitizeApprovalReviewText } from '../../../../../shared/contracts/approval-review.js';
import React, { type FC } from 'react';
import { Box, Text } from 'ink';
import type { ApprovalDescriptor } from '../../../approval-prompt.js';
import { type ColorRole, useTheme } from '../theme.js';
import { useSkin } from '../../skins/SkinContext.js';

type SafetyFindingLevel = 'RED' | 'YELLOW' | 'GREEN';

const SAFETY_FINDING_TONES: Record<SafetyFindingLevel, ColorRole> = {
  RED: 'danger',
  YELLOW: 'warning',
  GREEN: 'success',
};

type ParsedSystemSafetyReasoning = {
  findings: { level: SafetyFindingLevel; detail: string }[];
  modelAdvisory?: string;
};

/**
 * The safety evaluator deliberately keeps its advisory as plain text for
 * transport compatibility. Recover the structured severity markers only at
 * this presentation boundary so mixed findings remain scannable in a narrow
 * terminal.
 */
function parseSystemSafetyReasoning(reasoning: string): ParsedSystemSafetyReasoning | null {
  const modelAdvisoryMarker = '\n\nModel advisory:';
  const modelAdvisoryIndex = reasoning.indexOf(modelAdvisoryMarker);
  const safetyText = modelAdvisoryIndex >= 0 ? reasoning.slice(0, modelAdvisoryIndex) : reasoning;
  const modelAdvisory =
    modelAdvisoryIndex >= 0 ? reasoning.slice(modelAdvisoryIndex + modelAdvisoryMarker.length).trim() : undefined;
  const match = safetyText.match(
    /^Blocked by safety heuristics \(RED\): (.*)\. Manual approval is strictly required\.$/s,
  );
  if (!match) return null;

  const findings: ParsedSystemSafetyReasoning['findings'] = [];
  const findingPattern = /(?:^|;\s*)((?:RED|YELLOW|GREEN)):\s*(.*?)(?=;\s*(?:RED|YELLOW|GREEN):|$)/g;
  for (const finding of match[1].matchAll(findingPattern)) {
    findings.push({ level: finding[1] as SafetyFindingLevel, detail: finding[2] });
  }

  // A RED result can have no reason text if the classifier only returns its
  // status. Still make the blocking status visible instead of rendering an
  // empty findings section.
  if (findings.length === 0) {
    findings.push({ level: 'RED', detail: match[1] });
  }

  return { findings, ...(modelAdvisory ? { modelAdvisory } : {}) };
}

export const LLMAdvisory: FC<{ advisory: NonNullable<ApprovalDescriptor['llmAdvisory']> }> = ({
  advisory: original,
}) => {
  const advisory = {
    ...original,
    reasoning: sanitizeApprovalReviewText(original.reasoning),
    model: sanitizeApprovalReviewText(original.model),
  };
  const theme = useTheme();
  const { ToolSection } = useSkin();
  const isSystem = advisory.source === 'system';
  const tone: ColorRole = isSystem ? 'danger' : advisory.approved ? 'success' : 'warning';
  const label = isSystem ? 'System Safety Check: BLOCKED' : `AI Advisor: ${advisory.approved ? 'SAFE' : 'CAUTION'}`;
  const parsedSystemReasoning = isSystem ? parseSystemSafetyReasoning(advisory.reasoning) : null;

  return (
    <Box flexDirection="column" marginTop={1}>
      <ToolSection
        variant="callout"
        tone={tone}
        title={`${label} (${isSystem ? 'automated heuristic' : advisory.model})`}
      >
        {parsedSystemReasoning ? (
          <Box flexDirection="column" marginTop={1}>
            <Text bold color={theme.textMuted}>
              Heuristic findings:
            </Text>
            <Box flexDirection="column" marginLeft={1}>
              {parsedSystemReasoning.findings.map(({ level, detail }, index) => (
                <Box key={`${level}-${detail}-${index}`}>
                  <Text color={theme[SAFETY_FINDING_TONES[level]]} bold>
                    {`${level}:`.padEnd(8)}
                  </Text>
                  <Text color={theme.textMuted}>{detail}</Text>
                </Box>
              ))}
            </Box>
            <Box marginTop={1}>
              <Text color={theme.textMuted}>Manual approval is strictly required.</Text>
            </Box>
            {parsedSystemReasoning.modelAdvisory && (
              <Box flexDirection="column" marginTop={1}>
                <Text bold color={theme.textMuted}>
                  Model advisory:
                </Text>
                <Text italic color={theme.textMuted}>
                  {parsedSystemReasoning.modelAdvisory}
                </Text>
              </Box>
            )}
          </Box>
        ) : (
          <Box flexDirection="column">
            <Text italic color={theme.textMuted}>
              {isSystem ? advisory.reasoning : `"${advisory.reasoning}"`}
            </Text>
            {!isSystem && (advisory.riskLevel || advisory.authorization || advisory.confidence) && (
              <Text color={theme.textMuted}>{`Risk: ${advisory.riskLevel ?? 'unknown'} · Authorization: ${
                advisory.authorization ?? 'unknown'
              } · Confidence: ${advisory.confidence ?? 'unknown'}`}</Text>
            )}
          </Box>
        )}
      </ToolSection>
    </Box>
  );
};
