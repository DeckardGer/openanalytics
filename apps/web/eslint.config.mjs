import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Vendored chart primitives pulled in from the bklit shadcn registry —
    // third-party source we don't hand-maintain, so we don't hold it to our
    // hooks/immutability rules.
    "components/charts/**",
    "components/shimmering-text.tsx",
  ]),
]);

export default eslintConfig;
