import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import boundariesPlugin from 'eslint-plugin-boundaries';
import sonarjsPlugin from 'eslint-plugin-sonarjs';

export default [
    {
        files: ['src/**/*.ts'],
        languageOptions: {
            parser: tsParser,
            parserOptions: {
                ecmaVersion: 'latest',
                sourceType: 'module',
            },
        },
        plugins: {
            '@typescript-eslint': tsPlugin,
            boundaries: boundariesPlugin,
            sonarjs: sonarjsPlugin,
        },
        settings: {
            'boundaries/elements': [
                { type: 'domain', pattern: 'src/1_Domain/*' },
                { type: 'application', pattern: 'src/2_Application/*' },
                { type: 'infrastructure', pattern: 'src/3_Infrastructure/*' },
                { type: 'presentation', pattern: 'src/4_Presentation/*' },
            ],
        },
        rules: {
            // ==========================================
            // 1. DDD ARCHITECTURAL BOUNDARIES
            // ==========================================
            'boundaries/dependencies': [
                'error',
                {
                    default: 'disallow',
                    policies: [
                        { from: { element: { type: 'domain' } }, allow: [{ to: { element: { type: 'domain' } } }] },
                        { from: { element: { type: 'application' } }, allow: [{ to: { element: { type: 'domain' } } }, { to: { element: { type: 'application' } } }] },
                        { from: { element: { type: 'infrastructure' } }, allow: [{ to: { element: { type: 'domain' } } }, { to: { element: { type: 'infrastructure' } } }] },
                        { from: { element: { type: 'presentation' } }, allow: [{ to: { element: { type: 'domain' } } }, { to: { element: { type: 'application' } } }, { to: { element: { type: 'infrastructure' } } }, { to: { element: { type: 'presentation' } } }] },
                    ],
                },
            ],

            // ==========================================
            // 2. LINUS TORVALDS "3 TAB RULE" & SIMPLICITY
            // ==========================================
            'max-depth': ['error', 6],
            'indent': ['error', 'tab', { SwitchCase: 1 }],
            'complexity': ['error', 30],

            // ==========================================
            // 3. SOLID & CODE QUALITY
            // ==========================================
            'sonarjs/cognitive-complexity': ['error', 30],
            'sonarjs/no-identical-functions': 'off',
            'sonarjs/no-duplicated-branches': 'off',
        },
    },
];