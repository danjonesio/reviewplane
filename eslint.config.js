// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/*.d.ts"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Generated protocol validators embed the schema's character-class bounds
    // verbatim, and some of those deliberately exclude control characters.
    files: ["**/src/generated/**/*.ts"],
    rules: {
      "no-control-regex": "off",
    },
  },
  {
    // Plain Node scripts that are run directly rather than compiled. They are
    // outside a TypeScript program, so the runtime's own globals need declaring
    // here. `deploy/compose/e2e` holds the end-to-end harness's agent fixture,
    // which runs on the development fixture's Node and is copied into the
    // container rather than built.
    files: ["**/scripts/**/*.mjs", "deploy/compose/e2e/*.mjs"],
    languageOptions: {
      globals: {
        process: "readonly",
        fetch: "readonly",
        setTimeout: "readonly",
        URL: "readonly",
        console: "readonly",
      },
    },
  },
  {
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      eqeqeq: ["error", "always", { null: "ignore" }],
    },
  },
);
