# Website docs fix completion

- Task: website-docs-fix-2026-09-12
- Files changed: homepage renamed to index.mdx; gateway, CLI, getting-started, tools, non-interactive, sandbox, authentication, troubleshooting, slash-command, and 404 docs; generated settings reference; settings metadata/schema; docs workflow; website package scripts; link checker.
- Commands run:
  - pnpm --dir website build: PASS (final; 23 pages, link check passed; Astro emitted the existing /404 route conflict warning).
  - generated settings separator audit: PASS (all table rows have 7 unescaped separators).
  - pnpm test source/services/settings/settings-ui-metadata.test.ts source/services/settings/settings-schema.test.ts: PASS (40 tests).
  - pnpm test:related ./source/services/settings/settings-ui-metadata.ts ./source/services/settings/settings-schema.ts: FAIL (5 unrelated pre-existing environment/order failures in file-tool and nested-approval tests; 3709 passed).
  - pnpm typecheck: PASS.
  - git diff --check: PASS.
- Not fixed: unrelated failures reported by the related-test command; no full suite run per assignment scope.
DONE website-docs-fix-2026-09-12
DONE website-docs-fix-steer-2026-09-12
