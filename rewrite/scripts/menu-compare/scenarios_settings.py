"""Settings list, settings value editors and the /effort and /auto-approve value menus."""

_S = '/settings '

SCENARIOS = {
    # Settings list: every tab, both directions, scrolling, search and no-match.
    'settings-tab2': [_S, '<tab>', '<tab>'],
    'settings-tab3': [_S, '<tab>', '<tab>', '<tab>'],
    'settings-tab4': [_S] + ['<tab>'] * 4,
    'settings-tab5': [_S] + ['<tab>'] * 5,
    'settings-tab6': [_S] + ['<tab>'] * 6,
    'settings-tab7': [_S] + ['<tab>'] * 7,
    'settings-stab': [_S, '<stab>'],
    'settings-down': [_S, '<down>', '<down>', '<down>'],
    'settings-pgdn': [_S, '<pgdn>'],
    'settings-end': [_S, '<end>'],
    'settings-search-all': [_S, 'model'],
    'settings-none': [_S, 'zzzz'],
    'settings-esc': [_S, '<esc>'],
    'settings-bare': ['/settings<enter>'],
    # Value editors, one per value type.
    'settings-enum': [_S, 'ui.displayMode', '<enter>'],
    'settings-enum-down': [_S, 'ui.displayMode', '<enter>', '<down>'],
    'settings-bool': [_S, 'flex', '<enter>'],
    'settings-number': [_S, 'agent.temperature', '<enter>'],
    'settings-number-typed': [_S, 'agent.temperature', '<enter>', '0.5'],
    'settings-duration': [_S, 'shell.timeout', '<enter>'],
    'settings-text': [_S, 'searxng', '<enter>'],
    'settings-secret': [_S, 'tavily', '<enter>'],
    'settings-list': [_S, 'milestones', '<enter>'],
    'settings-value-back': [_S, 'ui.displayMode', '<enter>', '<esc>'],
    'settings-value-none': [_S, 'ui.displayMode', '<enter>', 'zzz', '<enter>'],
    'settings-apply': [_S, 'ui.displayMode', '<enter>', '<down>', '<enter>'],
    'settings-apply-number': [_S, 'agent.temperature', '<enter>', '0.5', '<enter>'],
    'settings-apply-empty': [_S, 'searxng', '<enter>', '<enter>'],
    # Reset list and a reset.
    'settings-reset-down': [_S + 'reset ', '<down>'],
    'settings-reset-apply': [_S + 'reset ', 'ui.displayMode', '<enter>'],
    # /effort and /auto-approve value menus.
    'effort-down': ['/effort ', '<down>', '<down>'],
    'effort-apply': ['/effort ', '<down>', '<down>', '<enter>'],
    'effort-filter': ['/effort ', 'hi'],
    'effort-none': ['/effort ', 'zzz'],
    'effort-esc': ['/effort ', '<esc>'],
    'effort-bare': ['/effort<enter>'],
    'effort-ctrl-t': ['<c-t>'],
    'auto-approve-down': ['/auto-approve ', '<down>'],
    'auto-approve-apply': ['/auto-approve ', '<down>', '<enter>'],
    'auto-approve-none': ['/auto-approve ', 'zzz'],
    'auto-approve-bare': ['/auto-approve<enter>'],
}


# A settings file an earlier run already filled in (agent.mentorReasoningEffort present): legacy's own migration
# then copies it to agent.smartReasoningEffort in both CLIs. On a fresh HOME only next shows it, because next writes
# the full settings file at launch and each session reloads it; see rewrite/docs/menu-port-report.md.
SCENARIOS['settings-second-run'] = ['/settings ']
SEED['settings-second-run'] = {'settings': {'agent': {
    'retryAttempts': 0,
    'modelSelection': {'model': 'mock-alpha', 'provider': 'mockprov'},
    'mentorReasoningEffort': 'default',
}}}
