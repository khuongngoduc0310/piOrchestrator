import js from "@eslint/js";
import tseslint from "typescript-eslint";
import importX from "eslint-plugin-import-x";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "src/dashboard-dist/**",
      "docs/**",
      "examples/**",
      ".gitnexus/**",
      ".git/**",
      "vite.dashboard.config.ts",
      "vitest.config.ts",
      "eslint.config.mjs"
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: {
      "import-x": importX,
      "react-hooks": reactHooks
    }
  },
  {
    files: ["src/**/*.{ts,tsx}", "!src/dashboard-client/**"],
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_"
      }],
      "@typescript-eslint/no-explicit-any": "off",
      "no-trailing-spaces": "error",
      "import-x/no-cycle": "error"
    }
  },
  {
    files: ["src/dashboard-client/**/*.{ts,tsx}"],
    languageOptions: {
      globals: globals.browser,
      parserOptions: {
        project: "./tsconfig.dashboard.json",
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_"
      }],
      "@typescript-eslint/no-explicit-any": "off",
      "no-trailing-spaces": "error",
      "import-x/no-cycle": "error"
    }
  },
  {
    files: [
      "src/ui/plan-review-component.ts",
      "src/ui/structured-agent-response.ts",
      "src/ui/terminal-ui.ts",
      "src/workspace/path-validation.ts",
      "src/agents/agent-runner.ts"
    ],
    rules: {
      "no-control-regex": "off"
    }
  },
  {
    files: ["src/orchestration/orchestrator-agent-step.ts"],
    rules: {
      "no-unsafe-finally": "off"
    }
  },
  {
    rules: {
      "no-empty": ["error", { "allowEmptyCatch": true }]
    }
  },
  {
    files: ["src/dashboard-client/**/*.{ts,tsx}"],
    ...reactHooks.configs.flat.recommended,
    rules: {
      "react-hooks/set-state-in-effect": "off"
    }
  }
);
