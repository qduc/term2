import fs from 'node:fs';
import path from 'node:path';

/**
 * The system prompt's role list, read from each role prompt's frontmatter
 * `description`. This file sits at the same depth as `tools/agent/`, so the
 * relative prompt paths below resolve as they did there.
 */
export function getSubagentsRolesSection({
  includeLibrarian = true,
  includeMentor = true,
}: { includeLibrarian?: boolean; includeMentor?: boolean } = {}): string {
  let promptsDir = path.join(import.meta.dirname, '../prompts/subagents');
  if (!fs.existsSync(promptsDir)) {
    const altDir = path.join(import.meta.dirname, '../../src/session/prompts/subagents');
    if (fs.existsSync(altDir)) {
      promptsDir = altDir;
    }
  }

  if (!fs.existsSync(promptsDir)) {
    return (
      '## Roles\n' +
      '- `explorer`: read-only evidence collection + web search + safe shell commands. Use for breadth across one defined surface or depth into one narrow seam, never both in one run.\n' +
      (includeMentor ? '- `mentor`: advisory only, no workspace access. Use for technical advice.\n' : '') +
      (includeLibrarian
        ? '- `librarian`: memory reasoning. Use for retrieving context from persistent memory and recommending memory maintenance.\n'
        : '') +
      '- `worker`: read + write + shell access. Use for implementing bounded file changes or general purpose works that does not fit any role above.\n\n'
    );
  }

  try {
    const files = fs
      .readdirSync(promptsDir)
      .filter((file) => file.endsWith('.md'))
      .sort();
    const roles: string[] = [];

    for (const file of files) {
      const roleName = path.basename(file, '.md');
      if ((roleName === 'librarian' && !includeLibrarian) || (roleName === 'mentor' && !includeMentor)) continue;
      const content = fs.readFileSync(path.join(promptsDir, file), 'utf-8');
      const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
      let description = '';
      if (match) {
        const frontmatterText = match[1];
        for (const line of frontmatterText.split('\n')) {
          const colonIdx = line.indexOf(':');
          if (colonIdx !== -1) {
            const key = line.slice(0, colonIdx).trim();
            if (key === 'description') {
              let val = line.slice(colonIdx + 1).trim();
              if (
                val.length >= 2 &&
                ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
              ) {
                val = val.slice(1, -1);
              }
              description = val;
              break;
            }
          }
        }
      }
      if (description) {
        roles.push(`- \`${roleName}\`: ${description}`);
      }
    }

    if (roles.length > 0) {
      return '## Roles\n' + roles.join('\n') + '\n\n';
    }
  } catch (_error) {
    // Fallback on error
  }

  return (
    '## Roles\n' +
    '- `explorer`: read-only evidence collection + web search + safe shell commands. Use for breadth across one defined surface or depth into one narrow seam, never both in one run.\n' +
    (includeMentor ? '- `mentor`: advisory only, no workspace access. Use for technical advice.\n' : '') +
    (includeLibrarian
      ? '- `librarian`: memory reasoning. Use for retrieving context from persistent memory and recommending memory maintenance.\n'
      : '') +
    '- `worker`: read + write access. Use for implementing bounded file changes.\n\n'
  );
}
