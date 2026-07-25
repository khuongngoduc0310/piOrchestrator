import type { AgentConfig, AgentName } from "./agent-types.js";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

export interface CheckDiscoveryResult {
  packageManager?: PackageManager;
  commands: string[];
  scripts: string[];
  diagnostics: string[];
}

export interface HumanTouchpoints {
  planApproval: boolean;
  planRevisionApproval: boolean;
  confirmBeforeMutation: boolean;
  importantDecisions: boolean;
  finalDeliveryApproval: boolean;
  diagnosisApproval: "never" | "low_confidence" | "always";
}

export type ParticipationProfile =
  | "autonomous"
  | "balanced"
  | "controlled"
  | "custom";

export interface ParticipationPolicy {
  profile: ParticipationProfile;
  initialPlanApproval: boolean;
  planRevisionApproval: boolean;
  mutationConfirmation: boolean;
  exceptionalDecisions: boolean;
  finalDeliveryApproval: boolean;
  diagnosisApproval: "never" | "low_confidence" | "always";
}

export interface OrchestratorConfig {
  schemaVersion: number;
  checks: string[];
  dashboard: { enabled: boolean; port: number };
  limits: {
    planRevisions: number;
    implementationRetries: number;
    reviewRevisions: number;
    agentTimeoutMs: number;
    checkTimeoutMs: number;
    maxOutputBytes: number;
    worktreeIsolation: boolean;
  };
  agents: Record<AgentName, AgentConfig>;
  humanInTheLoop: HumanTouchpoints;
}
