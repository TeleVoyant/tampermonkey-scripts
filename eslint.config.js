/*
 *
 *
 */

import js from "@eslint/js";

export default [
  js.configs.recommended,

  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
    },

    linterOptions: {
      reportUnusedDisableDirectives: true,
    },

    rules: {
      // 🔒 Possible Errors (make everything strict)
      "no-constant-condition": "error",
      "no-debugger": "error",
      "no-dupe-args": "error",
      "no-dupe-keys": "error",
      "no-duplicate-case": "error",
      "no-empty": ["error", { allowEmptyCatch: false }],
      "no-ex-assign": "error",
      "no-extra-boolean-cast": "error",
      "no-invalid-regexp": "error",
      "no-irregular-whitespace": "error",
      "no-loss-of-precision": "error",
      "no-unsafe-finally": "error",

      // 🧠 Best Practices (strict behavior)
      curly: ["error", "all"],
      "default-case": "error",
      "dot-notation": "error",
      eqeqeq: ["error", "always"],
      "no-alert": "error",
      "no-caller": "error",
      "no-eval": "error",
      "no-extend-native": "error",
      "no-extra-bind": "error",
      "no-implied-eval": "error",
      "no-lone-blocks": "error",
      "no-loop-func": "error",
      "no-multi-str": "error",
      "no-new-func": "error",
      "no-new-wrappers": "error",
      "no-octal": "error",
      "no-octal-escape": "error",
      "no-param-reassign": "error",
      "no-proto": "error",
      "no-return-await": "error",
      "no-self-compare": "error",
      "no-throw-literal": "error",
      "no-unmodified-loop-condition": "error",
      "no-unused-expressions": "error",
      "no-useless-call": "error",
      "no-useless-concat": "error",
      "no-useless-return": "error",
      "prefer-promise-reject-errors": "error",
      radix: "error",
      "require-await": "error",
      yoda: "error",

      // 📦 Variables (no sloppy code)
      "no-delete-var": "error",
      "no-shadow": "error",
      "no-undef": "error",
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "no-use-before-define": "error",

      // 🌍 ES6+ Strictness
      "arrow-body-style": ["error", "as-needed"],
      "arrow-parens": ["error", "always"],
      "constructor-super": "error",
      "no-class-assign": "error",
      "no-confusing-arrow": "error",
      "no-const-assign": "error",
      "no-dupe-class-members": "error",
      "no-new-symbol": "error",
      "no-this-before-super": "error",
      "prefer-const": "error",
      "prefer-rest-params": "error",
      "prefer-spread": "error",
      "prefer-template": "error",

      // 🧹 Stylistic (strict but not insane)
      semi: ["error", "always"],
      quotes: ["error", "double"],
      indent: ["error", 4],
      "comma-dangle": ["error", "always-multiline"],
      "no-trailing-spaces": "error",
      "eol-last": ["error", "always"],

      // 🚫 Opinionated strictness
      "no-console": "warn", // change to "error" if you want pain
      "max-depth": ["error", 4],
      "max-lines": ["warn", 300],
      complexity: ["error", 10],
    },
  },
];
