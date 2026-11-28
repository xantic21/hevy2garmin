import { defineConfig, configDefaults } from "vitest/config";
import path from "path";

// Resolve the `@/` path alias (matches tsconfig) so route handlers and libs
// that import `@/lib/*` can be unit-tested.
//
// Two projects, so every test states which sync mode it qualifies:
//  - "upstream" runs the inherited suite in the explicit legacy mode it was
//    written for (FIT upload, replace, routines, GitHub dispatch). A strict
//    deployment never runs that mode; these tests keep it intact.
//  - "strict" runs *.strict.test.ts with NO mode variables at all, which is
//    exactly what a strict deployment sees (strict is the fail-closed default).
const alias = { "@": path.resolve(__dirname, ".") };
const exclude = [...configDefaults.exclude, "e2e/**"];

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: "upstream",
          exclude: [...exclude, "**/*.strict.test.ts"],
          env: { H2G_SYNC_MODE: "legacy_upstream", H2G_LEGACY_UPSTREAM_ACK: "uploads-and-deletes-allowed" },
        },
      },
      {
        resolve: { alias },
        test: {
          name: "strict",
          include: ["**/*.strict.test.ts"],
          exclude,
          env: { H2G_SYNC_MODE: "", H2G_LEGACY_UPSTREAM_ACK: "", H2G_STRICT_AUTOMATIC: "" },
        },
      },
    ],
  },
});
