'use strict';

const eslint = require('@eslint/js');
const globals = require('globals');

module.exports = [
  {
    ignores: [
      '.homeybuild/**',
      'clone_modules/**',
      'node_modules/**',
    ],
  },
  eslint.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: globals.node,
    },
    rules: {
      'no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        caughtErrors: 'none',
      }],
    },
  },
];
