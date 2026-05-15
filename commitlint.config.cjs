module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'scope-enum': [
      2,
      'always',
      [
        'cli',
        'mcp',
        'core',
        'importers',
        'services',
        'tui',
        'docs',
        'test',
        'deps',
        'release',
        'infra',
        'api',
        'sync',
        'auth',
      ],
    ],
    'scope-empty': [2, 'never'],
  },
}
