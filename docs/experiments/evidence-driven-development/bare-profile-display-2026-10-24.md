# Duplicate profile labels in the old terminal UI

In the October 2026 UI, Bare and Pair could display the Standard label.
The profile registry, footer, and startup banner each encoded profile names.
The footer and banner tables lacked the new IDs and used a valid-looking
fallback. Sharing the registry-derived label removed both omissions at once.

The before/after check enumerated the registered profiles and rendered the
affected Ink surfaces. That checked the user-visible label and found the sibling
banner defect. A helper assertion alone would have missed the independent
table in the banner. The [historical report](https://github.com/qduc/term2/blob/c455d16c56dfa1d46664c0b3183873100942bf65/docs/experiments/evidence-driven-development/bare-profile-display-2026-10-24.md)
records the fixtures, coverage, and limits. The current terminal UI omits routine
profile labels as described in the [profile documentation](../../profiles/README.md).
