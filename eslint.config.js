import js from '@eslint/js';
import globals from 'globals';

export default [
    {ignores: ['node_modules/**', 'dist/**', 'dev/.tools/**']},
    js.configs.recommended,
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: {
                ...globals.es2022,
                global: 'readonly',
                logError: 'readonly',
                console: 'readonly',
                TextDecoder: 'readonly',
                TextEncoder: 'readonly',
            },
        },
        rules: {
            'consistent-return': 'error',
            'no-unused-vars': ['error', {argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_'}],
            'no-eval': 'error',
            'no-implied-eval': 'error',
            'no-new-func': 'error',
        },
    },
    {
        files: ['tests/unit/**/*.js', 'eslint.config.js'],
        languageOptions: {globals: globals.node},
    },
];
