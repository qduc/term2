"""Typed commands (menu closed by the trailing space): legacy's exact-or-unique-prefix resolution and its
Ambiguous / Unknown notices (source/utils/slash-command-dispatch.ts), and next-only aliases that must be gone.
These compare the notice row above the composer too (SEED 'notice')."""
SCENARIOS = {
    'typed-prefix-help': ['/he ', '<enter>'],
    'typed-case-help': ['/HELP ', '<enter>'],
    'typed-ambiguous': ['/re x', '<enter>'],
    'typed-ambiguous-c': ['/c ', '<enter>'],
    'typed-unknown-suggest': ['/qit ', '<enter>'],
    'typed-unknown': ['/stat ', '<enter>'],
    'typed-prefix-usage': ['/us ', '<enter>'],
    'typed-path-message': ['/tmp/foo bar', '<enter>'],
    'typed-exit': ['/exit ', '<enter>'],
    'typed-tasks': ['/tasks ', '<enter>'],
    'typed-steer': ['/steer hi', '<enter>'],
    'typed-followup': ['/followup hi', '<enter>'],
}
SEED = {name: {'notice': True} for name in SCENARIOS}
