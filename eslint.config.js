// @ts-check
// Root ESLint flat config (T00). A-01 §1.2: no package may use `child_process`, `vm` or `eval`.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const FORBIDDEN_MODULES = ['child_process', 'node:child_process', 'vm', 'node:vm'];
const FORBIDDEN_RE = '/^(node:)?(child_process|vm)$/';
const forbiddenMessage = 'A-01 §1.2: child_process / vm are forbidden in apps, services and packages.';

export default tseslint.config(
  {
    ignores: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/out/**', '**/coverage/**', 'spikes/**', 'docs/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // CommonJS config files (e.g. .dependency-cruiser.cjs)
    files: ['**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { require: 'readonly', module: 'writable', __dirname: 'readonly' },
    },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    // Product code: apps/*, services/*, packages/*.
    files: ['apps/**/*.{ts,tsx,js,mjs,cjs}', 'services/**/*.{ts,tsx,js,mjs,cjs}', 'packages/**/*.{ts,tsx,js,mjs,cjs}'],
    rules: {
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-restricted-imports': [
        'error',
        { paths: FORBIDDEN_MODULES.map((name) => ({ name, message: forbiddenMessage })) },
      ],
      'no-restricted-syntax': [
        'error',
        { selector: `ImportExpression[source.value=${FORBIDDEN_RE}]`, message: forbiddenMessage },
        {
          selector: `CallExpression[callee.name='require'][arguments.0.value=${FORBIDDEN_RE}]`,
          message: forbiddenMessage,
        },
        {
          selector: `TSImportEqualsDeclaration[moduleReference.expression.value=${FORBIDDEN_RE}]`,
          message: forbiddenMessage,
        },
        {
          selector: "CallExpression[callee.object.name='process'][callee.property.name='binding']",
          message: forbiddenMessage,
        },
      ],
    },
  },
);
