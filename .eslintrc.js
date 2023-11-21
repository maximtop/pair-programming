// eslint-disable-next-line @typescript-eslint/no-var-requires
const path = require('path');

module.exports = {
    root: true,
    parser: '@typescript-eslint/parser',
    parserOptions: {
        tsconfigRootDir: path.join(__dirname),
        project: 'tsconfig.eslint.json',
    },
    plugins: [
        'import',
        '@typescript-eslint',
    ],
    extends: [
        'airbnb-base',
        'airbnb-typescript/base',
    ],
    ignorePatterns: ['dist', 'coverage'],
    rules: {
        indent: 'off',
        '@typescript-eslint/indent': ['error', 4, {
            SwitchCase: 1,
            ignoredNodes: ['TSTypeParameterInstantiation'],
        }],
        'no-bitwise': 'off',
        'no-new': 'off',
        'max-len': ['error', { code: 120, ignoreUrls: true }],
        'import/prefer-default-export': 'off',
        '@typescript-eslint/no-non-null-assertion': 'off',
        'no-continue': 'off',
        'import/no-extraneous-dependencies': ['error', { devDependencies: true }],
        'no-restricted-syntax': ['error', 'LabeledStatement', 'WithStatement'],
        'no-constant-condition': ['error', { checkLoops: false }],
        '@typescript-eslint/interface-name-prefix': 'off',
        '@typescript-eslint/explicit-function-return-type': 'error',
        'arrow-body-style': 'off',
        'no-param-reassign': 'off',
        'import/no-cycle': 'off',
        'import/export': 'off',
    },
};
