import { FlatCompat } from '@eslint/eslintrc';
import js from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier/flat';
import legacyConfig from './.eslintrc.cjs';

const compat = new FlatCompat({
  baseDirectory: import.meta.dirname,
  recommendedConfig: js.configs.recommended,
});

export default [
  { ignores: ['**/dist/**', '**/coverage/**'] },
  ...compat.config(legacyConfig),
  eslintConfigPrettier,
];
