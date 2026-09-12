import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  site: 'https://qduc.github.io/term2/',
  base: '/term2/',
  integrations: [
    starlight({
      title: 'term2',
      description: 'Terminal-based AI assistant and autonomous agent runtime',
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/qduc/term2' }],
      sidebar: [
        {
          label: 'Getting Started',
          items: [
            { label: 'Overview', link: '/getting-started/' },
            { label: 'Installation', link: '/getting-started/installation/' },
            { label: 'First Run', link: '/getting-started/first-run/' },
          ],
        },
        {
          label: 'Using term2',
          items: [
            { label: 'Interactive TUI', link: '/using-term2/interactive-tui/' },
            { label: 'Non-Interactive Mode', link: '/using-term2/non-interactive/' },
            { label: 'Sessions & Resumption', link: '/using-term2/sessions/' },
            { label: 'Keyboard Shortcuts', link: '/using-term2/keyboard-shortcuts/' },
          ],
        },
        {
          label: 'Providers & Models',
          items: [
            { label: 'Providers Overview', link: '/providers/' },
            { label: 'Authentication & OAuth', link: '/providers/authentication/' },
            { label: 'Model Catalog & Reasoning', link: '/providers/model-catalog/' },
          ],
        },
        {
          label: 'Modes & Profiles',
          items: [
            { label: 'Operating Modes', link: '/modes/' },
            { label: 'Subagent Swarms', link: '/modes/subagents/' },
          ],
        },
        {
          label: 'Tools & Safety',
          items: [
            { label: 'Agent Tools', link: '/safety/tools/' },
            { label: 'Approvals & Run Budgets', link: '/safety/approvals/' },
            { label: 'Shell Sandbox', link: '/safety/sandbox/' },
          ],
        },
        {
          label: 'Remote & Integrations',
          items: [
            { label: 'Remote Development (SSH)', link: '/remote/ssh/' },
            { label: 'Web Gateway (term2 serve)', link: '/remote/web-gateway/' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'Slash Commands', link: '/reference/slash-commands/' },
            { label: 'CLI Flags', link: '/reference/cli-flags/' },
            { label: 'Settings Reference', link: '/reference/settings/' },
          ],
        },
        {
          label: 'Troubleshooting & FAQ',
          items: [{ label: 'Troubleshooting & FAQ', link: '/troubleshooting/' }],
        },
      ],
    }),
  ],
});
