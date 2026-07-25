import type {
  HumanTouchpoints,
  OrchestratorConfig,
  ParticipationPolicy,
  ParticipationProfile
} from "../types.js";

type DiagnosisConfidence = "low" | "medium" | "high";

const PROFILE_PRESETS: Record<"autonomous" | "balanced" | "controlled", Omit<ParticipationPolicy, "profile">> = {
  autonomous: {
    initialPlanApproval: false,
    planRevisionApproval: false,
    mutationConfirmation: false,
    exceptionalDecisions: false,
    finalDeliveryApproval: false,
    diagnosisApproval: "never"
  },
  balanced: {
    initialPlanApproval: true,
    planRevisionApproval: false,
    mutationConfirmation: true,
    exceptionalDecisions: true,
    finalDeliveryApproval: true,
    diagnosisApproval: "low_confidence"
  },
  controlled: {
    initialPlanApproval: true,
    planRevisionApproval: true,
    mutationConfirmation: true,
    exceptionalDecisions: true,
    finalDeliveryApproval: true,
    diagnosisApproval: "always"
  }
};

export function resolveParticipationPolicy(config: OrchestratorConfig): ParticipationPolicy {
  const h = config.humanInTheLoop;
  return {
    profile: inferParticipationProfile(h),
    initialPlanApproval: h.planApproval,
    planRevisionApproval: h.planRevisionApproval,
    mutationConfirmation: h.confirmBeforeMutation,
    exceptionalDecisions: h.importantDecisions,
    finalDeliveryApproval: h.finalDeliveryApproval,
    diagnosisApproval: h.diagnosisApproval
  };
}

export function inferParticipationProfile(h: HumanTouchpoints): ParticipationProfile {
  for (const [name, preset] of Object.entries(PROFILE_PRESETS) as Array<["autonomous" | "balanced" | "controlled", Omit<ParticipationPolicy, "profile">]>) {
    if (
      h.planApproval === preset.initialPlanApproval &&
      h.planRevisionApproval === preset.planRevisionApproval &&
      h.confirmBeforeMutation === preset.mutationConfirmation &&
      h.importantDecisions === preset.exceptionalDecisions &&
      h.finalDeliveryApproval === preset.finalDeliveryApproval &&
      h.diagnosisApproval === preset.diagnosisApproval
    ) {
      return name;
    }
  }
  return "custom";
}

export function applyParticipationProfile(
  config: OrchestratorConfig,
  profile: ParticipationProfile
): OrchestratorConfig {
  const preset = PROFILE_PRESETS[profile as keyof typeof PROFILE_PRESETS];
  if (!preset) return config;
  const updated = structuredClone(config);
  updated.humanInTheLoop.planApproval = preset.initialPlanApproval;
  updated.humanInTheLoop.planRevisionApproval = preset.planRevisionApproval;
  updated.humanInTheLoop.confirmBeforeMutation = preset.mutationConfirmation;
  updated.humanInTheLoop.importantDecisions = preset.exceptionalDecisions;
  updated.humanInTheLoop.finalDeliveryApproval = preset.finalDeliveryApproval;
  updated.humanInTheLoop.diagnosisApproval = preset.diagnosisApproval;
  return updated;
}

export type DecisionKind =
  | "initial_plan"
  | "plan_revision"
  | "mutation_confirmation"
  | "scope_expansion"
  | "code_review_rejection"
  | "repair_budget"
  | "final_delivery"
  | "baseline_repair"
  | "diagnosis_approval";

export function requiresHumanDecision(
  policy: ParticipationPolicy,
  decisionKind: DecisionKind,
  context?: { confidence?: DiagnosisConfidence }
): boolean {
  switch (decisionKind) {
    case "initial_plan":
      return policy.initialPlanApproval;
    case "plan_revision":
      return policy.planRevisionApproval;
    case "mutation_confirmation":
      return policy.mutationConfirmation;
    case "scope_expansion":
    case "code_review_rejection":
    case "repair_budget":
      return policy.exceptionalDecisions;
    case "final_delivery":
      return policy.finalDeliveryApproval;
    case "baseline_repair":
      return true;
    case "diagnosis_approval":
      switch (policy.diagnosisApproval) {
        case "never":
          return false;
        case "always":
          return true;
        case "low_confidence":
          return context?.confidence === "low";
      }
  }
}

export const PROFILE_DESCRIPTIONS: Record<ParticipationProfile, { label: string; preview: string }> = {
  autonomous: {
    label: "Autonomous",
    preview: "Machine reviews plan. No confirmations before mutation or delivery. Bug diagnoses run automatically."
  },
  balanced: {
    label: "Balanced",
    preview: "Human approves initial plan. Machine reviews revisions. Mutation and delivery require confirmation. Low-confidence diagnoses require approval."
  },
  controlled: {
    label: "Controlled",
    preview: "Human approves plan and all revisions. All mutations, deliveries, and diagnoses require explicit confirmation."
  },
  custom: {
    label: "Custom",
    preview: "Individual settings do not match a standard preset."
  }
};

export function getProfilePreset(profile: "autonomous" | "balanced" | "controlled"): Omit<ParticipationPolicy, "profile"> {
  return structuredClone(PROFILE_PRESETS[profile]);
}
