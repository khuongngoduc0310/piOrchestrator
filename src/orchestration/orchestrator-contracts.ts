import type { AgentExecutor } from "../agents/agent-runner.js";
import { runChecks } from "../checks/checks.js";
import type { RunStore } from "../persistence/store.js";

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
