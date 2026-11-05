"""Subagent pool editor branches, opened directly with `/settings agent.smartModel `."""

AGENT = {'retryAttempts': 0, 'modelSelection': {'model': 'mock-alpha', 'provider': 'mockprov'}}
POOL = {'settings': {'agent': {**AGENT, 'smartModel': [{'model': 'mock-beta', 'provider': 'mockprov'}]}}}
OPEN = '/settings agent.smartModel '

SCENARIOS = {
    'pool': [OPEN],
    'pool-down': [OPEN, '<down>'],
    'pool-add': [OPEN, '<enter>'],
    'pool-add-model': [OPEN, '<enter>', '<enter>'],
    'pool-add-model-tab': [OPEN, '<enter>', '<enter>', '<tab>'],
    'pool-add-model-filter': [OPEN, '<enter>', '<enter>', 'gam'],
    'pool-add-model-pick': [OPEN, '<enter>', '<enter>', '<down>', '<enter>'],
    'pool-add-provider': [OPEN, '<enter>', '<down>', '<enter>'],
    'pool-add-provider-pick': [OPEN, '<enter>', '<down>', '<enter>', '<enter>'],
    'pool-add-done': [OPEN, '<enter>', '<enter>', '<down>', '<enter>', '<down>', '<down>', '<enter>'],
    'pool-add-esc': [OPEN, '<enter>', '<esc>'],
    'pool-add-discard': [OPEN, '<enter>', '<enter>', '<down>', '<enter>', '<esc>'],
    'pool-add-discard-yes': [OPEN, '<enter>', '<enter>', '<down>', '<enter>', '<esc>', '<enter>'],
    'pool-model-esc': [OPEN, '<enter>', '<enter>', '<esc>'],
    'pool-save-empty': [OPEN, '<down>', '<enter>'],
    'pool-esc-empty': [OPEN, '<esc>'],
    'pool-seeded': [OPEN],
    'pool-seeded-edit': [OPEN, '<enter>'],
    'pool-seeded-delete': [OPEN, '<del>'],
    'pool-seeded-delete-yes': [OPEN, '<del>', '<enter>'],
    'pool-seeded-delete-no': [OPEN, '<del>', '<down>', '<enter>'],
    'pool-seeded-save': [OPEN, '<down>', '<down>', '<enter>'],
    'pool-seeded-esc': [OPEN, '<esc>'],
}

SEED = {name: POOL for name in SCENARIOS if name.startswith('pool-seeded')}
