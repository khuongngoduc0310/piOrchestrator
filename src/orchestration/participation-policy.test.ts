import { describe, expect, it } from "vitest";
import type { HumanTouchpoints, OrchestratorConfig } from "../config-types.js";
import {
  PROFILE_DESCRIPTIONS,
  applyParticipationProfile,
  getProfilePreset,
  inferParticipationProfile,
  requiresHumanDecision,
  resolveParticipationPolicy
} from "./participation-policy.js";
import { DEFAULT_CONFIG } from "../config/config.js";

function configWithTouchpoints(h: HumanTouchpoints): OrchestratorConfig {
  return { ...structuredClone(DEFAULT_CONFIG), humanInTheLoop: { ...h } };
}

describe("resolveParticipationPolicy", () => {
  it("maps config touchpoints to policy fields", () => {
    const config = configWithTouchpoints({
      planApproval: true,
      planRevisionApproval: true,
      confirmBeforeMutation: false,
      importantDecisions: true,
      finalDeliveryApproval: false,
      diagnosisApproval: "always"
    });
    const policy = resolveParticipationPolicy(config);
    expect(policy.initialPlanApproval).toBe(true);
    expect(policy.planRevisionApproval).toBe(true);
    expect(policy.mutationConfirmation).toBe(false);
    expect(policy.exceptionalDecisions).toBe(true);
    expect(policy.finalDeliveryApproval).toBe(false);
    expect(policy.diagnosisApproval).toBe("always");
  });

  it("infers profile from matching touchpoints", () => {
    const config = configWithTouchpoints({
      planApproval: true,
      planRevisionApproval: false,
      confirmBeforeMutation: true,
      importantDecisions: true,
      finalDeliveryApproval: true,
      diagnosisApproval: "low_confidence"
    });
    expect(resolveParticipationPolicy(config).profile).toBe("balanced");
  });
});

describe("inferParticipationProfile", () => {
  it("returns autonomous when all fields match preset", () => {
    expect(inferParticipationProfile({
      planApproval: false,
      planRevisionApproval: false,
      confirmBeforeMutation: false,
      importantDecisions: false,
      finalDeliveryApproval: false,
      diagnosisApproval: "never"
    })).toBe("autonomous");
  });

  it("returns balanced when all fields match preset", () => {
    expect(inferParticipationProfile({
      planApproval: true,
      planRevisionApproval: false,
      confirmBeforeMutation: true,
      importantDecisions: true,
      finalDeliveryApproval: true,
      diagnosisApproval: "low_confidence"
    })).toBe("balanced");
  });

  it("returns controlled when all fields match preset", () => {
    expect(inferParticipationProfile({
      planApproval: true,
      planRevisionApproval: true,
      confirmBeforeMutation: true,
      importantDecisions: true,
      finalDeliveryApproval: true,
      diagnosisApproval: "always"
    })).toBe("controlled");
  });

  it("returns custom when fields do not match any preset", () => {
    expect(inferParticipationProfile({
      planApproval: true,
      planRevisionApproval: false,
      confirmBeforeMutation: false,
      importantDecisions: true,
      finalDeliveryApproval: false,
      diagnosisApproval: "never"
    })).toBe("custom");
  });

  it("returns custom when only one field differs from a preset", () => {
    expect(inferParticipationProfile({
      planApproval: false,
      planRevisionApproval: false,
      confirmBeforeMutation: false,
      importantDecisions: false,
      finalDeliveryApproval: false,
      diagnosisApproval: "low_confidence"
    })).toBe("custom");
  });
});

describe("applyParticipationProfile", () => {
  it("applies autonomous preset to config", () => {
    const config = configWithTouchpoints({
      planApproval: true,
      planRevisionApproval: true,
      confirmBeforeMutation: true,
      importantDecisions: true,
      finalDeliveryApproval: true,
      diagnosisApproval: "always"
    });
    const updated = applyParticipationProfile(config, "autonomous");
    expect(updated.humanInTheLoop.planApproval).toBe(false);
    expect(updated.humanInTheLoop.planRevisionApproval).toBe(false);
    expect(updated.humanInTheLoop.confirmBeforeMutation).toBe(false);
    expect(updated.humanInTheLoop.importantDecisions).toBe(false);
    expect(updated.humanInTheLoop.finalDeliveryApproval).toBe(false);
    expect(updated.humanInTheLoop.diagnosisApproval).toBe("never");
  });

  it("applies controlled preset to config", () => {
    const config = configWithTouchpoints({
      planApproval: false,
      planRevisionApproval: false,
      confirmBeforeMutation: false,
      importantDecisions: false,
      finalDeliveryApproval: false,
      diagnosisApproval: "never"
    });
    const updated = applyParticipationProfile(config, "controlled");
    expect(updated.humanInTheLoop.planApproval).toBe(true);
    expect(updated.humanInTheLoop.planRevisionApproval).toBe(true);
    expect(updated.humanInTheLoop.confirmBeforeMutation).toBe(true);
    expect(updated.humanInTheLoop.importantDecisions).toBe(true);
    expect(updated.humanInTheLoop.finalDeliveryApproval).toBe(true);
    expect(updated.humanInTheLoop.diagnosisApproval).toBe("always");
  });

  it("returns config unchanged for custom profile", () => {
    const config = configWithTouchpoints({
      planApproval: true,
      planRevisionApproval: false,
      confirmBeforeMutation: false,
      importantDecisions: true,
      finalDeliveryApproval: false,
      diagnosisApproval: "never"
    });
    const updated = applyParticipationProfile(config, "custom");
    expect(updated).toEqual(config);
  });

  it("does not mutate the original config", () => {
    const config = configWithTouchpoints({
      planApproval: false,
      planRevisionApproval: false,
      confirmBeforeMutation: false,
      importantDecisions: false,
      finalDeliveryApproval: false,
      diagnosisApproval: "never"
    });
    applyParticipationProfile(config, "controlled");
    expect(config.humanInTheLoop.planApproval).toBe(false);
  });
});

describe("getProfilePreset", () => {
  it("returns autonomous preset fields", () => {
    const preset = getProfilePreset("autonomous");
    expect(preset.initialPlanApproval).toBe(false);
    expect(preset.mutationConfirmation).toBe(false);
    expect(preset.exceptionalDecisions).toBe(false);
    expect(preset.finalDeliveryApproval).toBe(false);
    expect(preset.diagnosisApproval).toBe("never");
  });

  it("returns a copy that does not affect the original", () => {
    const preset = getProfilePreset("balanced");
    preset.initialPlanApproval = false;
    expect(getProfilePreset("balanced").initialPlanApproval).toBe(true);
  });
});

describe("requiresHumanDecision", () => {
  const autonomous = resolveParticipationPolicy(configWithTouchpoints({
    planApproval: false, planRevisionApproval: false, confirmBeforeMutation: false,
    importantDecisions: false, finalDeliveryApproval: false, diagnosisApproval: "never"
  }));
  const balanced = resolveParticipationPolicy(configWithTouchpoints({
    planApproval: true, planRevisionApproval: false, confirmBeforeMutation: true,
    importantDecisions: true, finalDeliveryApproval: true, diagnosisApproval: "low_confidence"
  }));
  const controlled = resolveParticipationPolicy(configWithTouchpoints({
    planApproval: true, planRevisionApproval: true, confirmBeforeMutation: true,
    importantDecisions: true, finalDeliveryApproval: true, diagnosisApproval: "always"
  }));

  describe("initial_plan", () => {
    it("autonomous skips", () => expect(requiresHumanDecision(autonomous, "initial_plan")).toBe(false));
    it("balanced requires", () => expect(requiresHumanDecision(balanced, "initial_plan")).toBe(true));
    it("controlled requires", () => expect(requiresHumanDecision(controlled, "initial_plan")).toBe(true));
  });

  describe("plan_revision", () => {
    it("autonomous skips", () => expect(requiresHumanDecision(autonomous, "plan_revision")).toBe(false));
    it("balanced skips", () => expect(requiresHumanDecision(balanced, "plan_revision")).toBe(false));
    it("controlled requires", () => expect(requiresHumanDecision(controlled, "plan_revision")).toBe(true));
  });

  describe("mutation_confirmation", () => {
    it("autonomous skips", () => expect(requiresHumanDecision(autonomous, "mutation_confirmation")).toBe(false));
    it("balanced requires", () => expect(requiresHumanDecision(balanced, "mutation_confirmation")).toBe(true));
    it("controlled requires", () => expect(requiresHumanDecision(controlled, "mutation_confirmation")).toBe(true));
  });

  describe("scope_expansion", () => {
    it("autonomous skips", () => expect(requiresHumanDecision(autonomous, "scope_expansion")).toBe(false));
    it("balanced requires", () => expect(requiresHumanDecision(balanced, "scope_expansion")).toBe(true));
    it("controlled requires", () => expect(requiresHumanDecision(controlled, "scope_expansion")).toBe(true));
  });

  describe("code_review_rejection", () => {
    it("autonomous skips", () => expect(requiresHumanDecision(autonomous, "code_review_rejection")).toBe(false));
    it("balanced requires", () => expect(requiresHumanDecision(balanced, "code_review_rejection")).toBe(true));
    it("controlled requires", () => expect(requiresHumanDecision(controlled, "code_review_rejection")).toBe(true));
  });

  describe("repair_budget", () => {
    it("autonomous skips", () => expect(requiresHumanDecision(autonomous, "repair_budget")).toBe(false));
    it("balanced requires", () => expect(requiresHumanDecision(balanced, "repair_budget")).toBe(true));
    it("controlled requires", () => expect(requiresHumanDecision(controlled, "repair_budget")).toBe(true));
  });

  describe("final_delivery", () => {
    it("autonomous skips", () => expect(requiresHumanDecision(autonomous, "final_delivery")).toBe(false));
    it("balanced requires", () => expect(requiresHumanDecision(balanced, "final_delivery")).toBe(true));
    it("controlled requires", () => expect(requiresHumanDecision(controlled, "final_delivery")).toBe(true));
  });

  describe("baseline_repair", () => {
    it("always requires regardless of profile", () => {
      expect(requiresHumanDecision(autonomous, "baseline_repair")).toBe(true);
      expect(requiresHumanDecision(balanced, "baseline_repair")).toBe(true);
      expect(requiresHumanDecision(controlled, "baseline_repair")).toBe(true);
    });
  });

  describe("diagnosis_approval", () => {
    it("autonomous never requires", () => {
      expect(requiresHumanDecision(autonomous, "diagnosis_approval")).toBe(false);
      expect(requiresHumanDecision(autonomous, "diagnosis_approval", { confidence: "low" })).toBe(false);
    });
    it("balanced requires only for low confidence", () => {
      expect(requiresHumanDecision(balanced, "diagnosis_approval")).toBe(false);
      expect(requiresHumanDecision(balanced, "diagnosis_approval", { confidence: "low" })).toBe(true);
      expect(requiresHumanDecision(balanced, "diagnosis_approval", { confidence: "high" })).toBe(false);
    });
    it("controlled always requires", () => {
      expect(requiresHumanDecision(controlled, "diagnosis_approval")).toBe(true);
      expect(requiresHumanDecision(controlled, "diagnosis_approval", { confidence: "low" })).toBe(true);
      expect(requiresHumanDecision(controlled, "diagnosis_approval", { confidence: "high" })).toBe(true);
    });
  });
});

describe("PROFILE_DESCRIPTIONS", () => {
  it("has entries for all profiles", () => {
    for (const profile of ["autonomous", "balanced", "controlled", "custom"] as const) {
      expect(PROFILE_DESCRIPTIONS[profile]).toBeDefined();
      expect(typeof PROFILE_DESCRIPTIONS[profile].label).toBe("string");
      expect(typeof PROFILE_DESCRIPTIONS[profile].preview).toBe("string");
    }
  });
});
