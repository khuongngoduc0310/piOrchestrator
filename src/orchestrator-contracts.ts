import type { AgentExecutor } from "./agent-runner.js";
import { runChecks } from "./checks.js";
import type { RunStore } from "./store.js";

export type CheckRunner = typeof runChecks;

export interface OrchestratorDependencies {
  agentExecutor?: AgentExecutor;
  checkRunner?: CheckRunner;
  storeFactory?: (cwd: string, runId: string) => RunStore;
  now?: () => Date;
  id?: () => string;
  openBrowser?: (url: string) => void;
  enforceWorkspacePolicy?: boolean;
}
