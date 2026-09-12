// GhostTrace - ESLint flat config
// Kurulum: npm install  ->  npm run lint
import js from '@eslint/js';

const webextensionGlobals = {
  chrome: 'readonly',
  console: 'readonly',
  document: 'readonly',
  window: 'readonly',
  navigator: 'readonly',
  location: 'readonly',
  history: 'readonly',
  crypto: 'readonly',
  DocumentFragment: 'readonly',
  HTMLElement: 'readonly',
  Element: 'readonly',
  fetch: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  Blob: 'readonly',
  FileReader: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
  structuredClone: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  queueMicrotask: 'readonly',
  requestAnimationFrame: 'readonly',
  performance: 'readonly',
  PerformanceObserver: 'readonly',
  CustomEvent: 'readonly',
  Intl: 'readonly',
  self: 'readonly',
  globalThis: 'readonly'
};

export default [
  js.configs.recommended,
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: webextensionGlobals
    },
    linterOptions: { reportUnusedDisableDirectives: true },
    rules: {
      'no-unused-vars': ['error', { args: 'after-used', argsIgnorePattern: '^_' }],
      'no-undef': 'error',
      'no-empty': ['error', { allowEmptyCatch: false }],
      'no-var': 'error',
      'prefer-const': 'error',
      eqeqeq: ['error', 'smart'],
      'no-implicit-coercion': 'off',
      'require-atomic-updates': 'off',
      'no-console': 'off'
    }
  },
  {
    files: ['test/**/*.js', 'tools/**/*.mjs'],
    languageOptions: {
      globals: { ...webextensionGlobals, process: 'readonly', Buffer: 'readonly', __dirname: 'readonly' }
    }
  },
  {
    // Gercek tarayici testleri node baglaminda kosar; WebSocket Node 22+ yerlesigi.
    files: ['test/e2e/**/*.mjs'],
    languageOptions: {
      globals: { ...webextensionGlobals, process: 'readonly', Buffer: 'readonly', WebSocket: 'readonly' }
    }
  },
  { ignores: ['lib/psl.js', '.cache/**'] }
];
