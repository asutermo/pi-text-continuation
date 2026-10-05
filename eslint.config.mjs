export default [{ ignores: ["node_modules/**"] }, {
  files: ["**/*.mjs"],
  languageOptions: {
    ecmaVersion: 2024,
    sourceType: "module",
    globals: Object.fromEntries([
      "process", "console", "performance", "AbortSignal", "URL", "Buffer",
      "setTimeout", "clearTimeout",
    ].map(name => [name, "readonly"])),
  },
  rules: {
    "no-undef": "error",
    "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    "no-unreachable": "error",
    "no-dupe-keys": "error",
    "no-constant-condition": "error",
    "no-async-promise-executor": "error",
    "no-promise-executor-return": "error",
    "eqeqeq": "error",
    "prefer-const": ["error", { ignoreReadBeforeAssign: true }],
  },
}];
