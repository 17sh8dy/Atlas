import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.turbo/**',
      // Cargo's build directory contains generated JS that Tauri injects into
      // the webview. It isn't ours, isn't source, and isn't valid standalone.
      '**/src-tauri/target/**',
      '**/src-tauri/gen/**',
    ],
  },
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
    // Build scripts are plain Node ES modules, not browser code.
    files: ['**/scripts/**/*.mjs'],
    languageOptions: { globals: globals.node, sourceType: 'module' },
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
                '@atlas/engine',
                '@atlas/platform',
                '@tauri-apps/*',
              ],
              message: 'core is the inner layer; dependencies must point inward.',
            },
          ],
        },
      ],
    },
  },
  {
    // The engine is the next ring out: it may know the domain, and nothing else.
    // This is what keeps it runnable in a window, a browser tab and a test.
    files: ['packages/engine/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'react', message: 'the engine renders nothing.' },
            { name: 'react-dom', message: 'the engine renders nothing.' },
          ],
          patterns: [
            {
              group: ['@atlas/ui', '@atlas/platform', '@tauri-apps/*'],
              message:
                'the engine reaches the machine through the Platform port, never a concrete impl.',
            },
          ],
        },
      ],
    },
  },
);
