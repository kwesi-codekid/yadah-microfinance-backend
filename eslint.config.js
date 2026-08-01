import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', 'coverage/'] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // This is a ledger: floating promises and loose money math are bugs.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'parseFloat', message: 'Money is integer pesewas — no float parsing.' },
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'Number',
          property: 'parseFloat',
          message: 'Money is integer pesewas — no float parsing.',
        },
      ],
      eqeqeq: ['error', 'always'],
    },
  },
  {
    // Config files and integration tests sit outside the src tsconfig —
    // lint them without type information.
    files: ['**/*.js', 'tests/**/*.ts', 'vitest*.config.ts'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ['**/*.test.ts', '**/*.spec.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  prettier,
);
