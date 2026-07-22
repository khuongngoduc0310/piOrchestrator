export const WORKFLOW_TERMINATION_KINDS = [
  "cancelled",
  "human_gate_unavailable",
  "gate_interaction_failed",
  "capability_violation",
  "mutation_boundary_violation",
  "workflow_failed"
] as const;

export type WorkflowTerminationKind = (typeof WORKFLOW_TERMINATION_KINDS)[number];
export type WorkflowTerminalStatus = "cancelled" | "failed";
export type CancellationSource = "human_gate" | "command" | "shutdown" | "agent_abort";

export interface WorkflowTermination {
  kind: WorkflowTerminationKind;
  code: WorkflowTerminationKind;
  status: WorkflowTerminalStatus;
  message: string;
  source?: CancellationSource;
  stoppedStage?: string;
}

export class WorkflowTerminationError extends Error {
  readonly kind: WorkflowTerminationKind;
  readonly code: WorkflowTerminationKind;
  readonly status: WorkflowTerminalStatus;
  readonly termination: WorkflowTermination;

  constructor(
    kind: WorkflowTerminationKind,
    status: WorkflowTerminalStatus,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "WorkflowTerminationError";
    this.kind = kind;
    this.code = kind;
    this.status = status;
    this.termination = { kind, code: kind, status, message };
  }
}

export class WorkflowCancelledError extends WorkflowTerminationError {
  readonly source: CancellationSource;

  constructor(message = "Workflow cancelled", source: CancellationSource = "human_gate", options?: ErrorOptions) {
    super("cancelled", "cancelled", message, options);
    this.name = "WorkflowCancelledError";
    this.source = source;
    this.termination.source = source;
  }
}

export class HumanGateUnavailableError extends WorkflowTerminationError {
  constructor(message = "Required human interaction is unavailable", options?: ErrorOptions) {
    super("human_gate_unavailable", "failed", message, options);
    this.name = "HumanGateUnavailableError";
  }
}

export class GateInteractionError extends WorkflowTerminationError {
  constructor(message = "Human gate interaction failed", options?: ErrorOptions) {
    super("gate_interaction_failed", "failed", message, options);
    this.name = "GateInteractionError";
  }
}

export class CapabilityViolationError extends WorkflowTerminationError {
  constructor(message = "Agent capability policy was violated", options?: ErrorOptions) {
    super("capability_violation", "failed", message, options);
    this.name = "CapabilityViolationError";
  }
}

export class MutationBoundaryError extends WorkflowTerminationError {
  constructor(message = "Mutation boundary was crossed", options?: ErrorOptions) {
    super("mutation_boundary_violation", "failed", message, options);
    this.name = "MutationBoundaryError";
  }
}

// Alternate names keep callers focused on the failure concept rather than class wording.
export { WorkflowCancelledError as WorkflowCancellationError };
export { HumanGateUnavailableError as UnavailableHumanGateError };
export { GateInteractionError as HumanGateInteractionError };

export function isWorkflowTermination(value: unknown): value is WorkflowTermination {
  if (!isRecord(value)) return false;
  return typeof value.message === "string"
    && typeof value.kind === "string"
    && WORKFLOW_TERMINATION_KINDS.includes(value.kind as WorkflowTerminationKind);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
