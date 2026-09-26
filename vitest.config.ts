import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Mirror tsconfig's "@/*" → repo root so tests resolve app imports.
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
  test: {
    include: ["**/*.test.ts"],
    // .claude/** holds harness worktrees — full repo copies that once
    // silently doubled the suite (1383 "passing" tests, half of them a
    // stale checkout's). Generated and tool dirs are not the codebase.
    exclude: [
      "node_modules/**",
      ".next/**",
      "productos/**",
      ".claude/**",
      ".vercel/**",
      ".data/**",
    ],
    // Test files share one Postgres; the vocab and bank suites both rewrite
    // the vocabulary mirror, so files must not interleave.
    fileParallelism: false,
    // That same shared Postgres is often also serving a running dev server.
    // Under that contention, multi-write DB tests that finish in ~1s alone
    // have been measured at 5–7s in the full batch — past the 5s default,
    // which made the suite flake by machine load rather than by defect.
    testTimeout: 15_000,
  },
});
