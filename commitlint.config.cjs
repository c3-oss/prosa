const scopes = [
  'agents',
  'cli',
  'deps',
  'docs',
  'importers',
  'panel',
  'proto',
  'release',
  'server',
  'session',
  'store',
  'tooling'
]

module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'scope-empty': [2, 'never'],
    'scope-enum': [2, 'always', { scopes, delimiters: [','] }]
  }
}
