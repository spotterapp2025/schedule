import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["node_modules/**"] },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
      "prefer-const": "error",
      eqeqeq: ["error", "smart"],
      "no-console": ["error", { allow: ["error"] }],
    },
  },
  {
    // The logger is the one place that writes to the console.
    files: ["src/logger.js"],
    rules: { "no-console": "off" },
  },
];
