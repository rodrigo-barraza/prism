import js from '@eslint/js';
import prettierConfig from 'eslint-config-prettier';

export default [
    js.configs.recommended,
    prettierConfig,
    {
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: {
                process: 'readonly',
                console: 'readonly',
                Buffer: 'readonly',
                URL: 'readonly',
                fetch: 'readonly',
                setInterval: 'readonly',
                clearInterval: 'readonly',
                setTimeout: 'readonly',
                clearTimeout: 'readonly',
            },
        },
        rules: {
            'no-unused-vars': ['error', { argsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_', varsIgnorePattern: '^_' }],
            'no-console': 'off',
            'prefer-const': 'error',
            'no-var': 'error',
        },
    },
    {
        ignores: ['node_modules/'],
    },
];
