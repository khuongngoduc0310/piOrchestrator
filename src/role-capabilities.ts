import { BUILT_IN_TOOLS, type AgentName, type BuiltInToolName } from "./types.js";

export const MUTATION_KINDS = ["none", "tests", "plan_files", "documentation"] as const;
export type MutationKind = (typeof MUTATION_KINDS)[number];

export interface RoleCapability {
  readonly tools: readonly BuiltInToolName[];
  readonly mutation: MutationKind;
}

const READ_ONLY_TOOLS = Object.freeze(["read", "grep", "find", "ls"] as const);
const MUTATING_TOOLS = Object.freeze(["read", "write", "edit", "grep", "find", "ls"] as const);

export const ROLE_CAPABILITIES: Readonly<Record<AgentName, RoleCapability>> = Object.freeze({
  explorer: Object.freeze({ tools: READ_ONLY_TOOLS, mutation: "none" }),
  planner: Object.freeze({ tools: READ_ONLY_TOOLS, mutation: "none" }),
  reviewer: Object.freeze({ tools: READ_ONLY_TOOLS, mutation: "none" }),
  tester: Object.freeze({ tools: MUTATING_TOOLS, mutation: "tests" }),
  builder: Object.freeze({ tools: MUTATING_TOOLS, mutation: "plan_files" }),
  debugger: Object.freeze({ tools: READ_ONLY_TOOLS, mutation: "none" }),
  documenter: Object.freeze({ tools: MUTATING_TOOLS, mutation: "documentation" })
});

export const ROLE_MAXIMUM_TOOLS: Readonly<Record<AgentName, readonly BuiltInToolName[]>> = Object.freeze({
  explorer: ROLE_CAPABILITIES.explorer.tools,
  planner: ROLE_CAPABILITIES.planner.tools,
  reviewer: ROLE_CAPABILITIES.reviewer.tools,
  tester: ROLE_CAPABILITIES.tester.tools,
  builder: ROLE_CAPABILITIES.builder.tools,
  debugger: ROLE_CAPABILITIES.debugger.tools,
  documenter: ROLE_CAPABILITIES.documenter.tools
});

export const ROLE_MUTATION_KINDS: Readonly<Record<AgentName, MutationKind>> = Object.freeze({
  explorer: ROLE_CAPABILITIES.explorer.mutation,
  planner: ROLE_CAPABILITIES.planner.mutation,
  reviewer: ROLE_CAPABILITIES.reviewer.mutation,
  tester: ROLE_CAPABILITIES.tester.mutation,
  builder: ROLE_CAPABILITIES.builder.mutation,
  debugger: ROLE_CAPABILITIES.debugger.mutation,
  documenter: ROLE_CAPABILITIES.documenter.mutation
});

export class RoleCapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoleCapabilityError";
  }
}

/** Return configured tools that are within the role maximum, preserving configured order. */
export function intersectRoleTools(
  role: AgentName,
  configuredTools: readonly BuiltInToolName[]
): BuiltInToolName[] {
  const maximum = new Set(ROLE_MAXIMUM_TOOLS[role]);
  const seen = new Set<BuiltInToolName>();
  return configuredTools.filter(tool => {
    if (!maximum.has(tool) || seen.has(tool)) return false;
    seen.add(tool);
    return true;
  });
}

/** Validate that configuration narrows, rather than expands, the immutable role maximum. */
export function validateRoleTools(
  role: AgentName,
  configuredTools: readonly BuiltInToolName[]
): BuiltInToolName[] {
  const knownTools = new Set<string>(BUILT_IN_TOOLS);
  const maximum = new Set<BuiltInToolName>(ROLE_MAXIMUM_TOOLS[role]);
  const seen = new Set<BuiltInToolName>();

  for (const tool of configuredTools) {
    if (!knownTools.has(tool)) {
      throw new RoleCapabilityError(`${role} configures unknown built-in tool: ${tool}`);
    }
    if (!maximum.has(tool)) {
      throw new RoleCapabilityError(`${role} may not use tool: ${tool}`);
    }
    if (seen.has(tool)) {
      throw new RoleCapabilityError(`${role} configures duplicate tool: ${tool}`);
    }
    seen.add(tool);
  }

  return [...configuredTools];
}
