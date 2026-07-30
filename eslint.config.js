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
    // outside a TypeScript program, so `process` needs declaring here.
    files: ["**/scripts/**/*.mjs"],
    languageOptions: {
      globals: { process: "readonly" },
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
