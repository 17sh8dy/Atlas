import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/.turbo/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: { ...reactHooks.configs.recommended.rules },
  },
  {
    // CommonJS config files (tailwind/postcss presets)
    files: ['**/*.cjs'],
    languageOptions: {
      globals: globals.node,
      sourceType: 'commonjs',
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    // Architectural boundary: core is the inner domain layer.
    // Dependencies must point inward — core imports no framework or infra.
    files: ['packages/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'react', message: 'core must stay framework-free.' },
            { name: 'react-dom', message: 'core must stay framework-free.' },
          ],
          patterns: [
            {
              group: [
                '@atlas/ui',
                '@atlas/data',
                '@atlas/platform',
                '@tauri-apps/*',
                '@supabase/*',
              ],
              message: 'core is the inner layer; dependencies must point inward.',
            },
          ],
        },
      ],
    },
  },
);
