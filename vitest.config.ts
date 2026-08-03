import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/**/*.test.{ts,tsx}",
        "src/dashboard-dist/**",
        "src/dashboard-client/index.html"
      ],
      thresholds: {
        statements: 60,
        branches: 50,
        functions: 60,
        lines: 64
      }
    }
  }
});
