import js from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import { importX } from 'eslint-plugin-import-x';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    { ignores: ['dist', 'coverage'] },
    js.configs.recommended,
    tseslint.configs.recommended,
    stylistic.configs.customize({
        indent: 4,
        semi: true,
        quotes: 'single',
        commaDangle: 'always-multiline',
        braceStyle: '1tbs',
        arrowParens: true,
    }),
    {
        plugins: { 'import-x': importX },
        rules: {
            '@stylistic/max-len': ['error', { code: 120, ignoreUrls: true }],
            '@stylistic/quote-props': ['error', 'as-needed'],
            '@typescript-eslint/explicit-function-return-type': 'error',
            'no-console': 'error',
            'import-x/first': 'error',
            'import-x/newline-after-import': 'error',
            'import-x/no-duplicates': 'error',
            'import-x/order': ['error', { 'newlines-between': 'always' }],
        },
    },
);
