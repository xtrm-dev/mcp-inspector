import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // ponytail: default include is fine; only exclude paths that would
    // double-count tests (xt worktrees shadow the full source tree) or
    // pull in the packaged build's copies.
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/dist-package/**",
      ".xtrm/**",
    ],
  },
});
