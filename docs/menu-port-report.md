# Historical terminal menu port

During the Term2 rewrite, the menu port used PTY captures to compare the legacy
and rewritten screens, including per-cell color and style. The comparison used
two builds and a scripted provider. It belongs to the migration, whose two-build
layout has since been retired.

The [original menu port report](https://github.com/qduc/term2/blob/c455d16c56dfa1d46664c0b3183873100942bf65/docs/menu-port-report.md)
records the comparison method, accepted differences, and captures. For current
menu input ownership, see [the terminal input skill](../.agents/skills/terminal-input-ownership/SKILL.md).
