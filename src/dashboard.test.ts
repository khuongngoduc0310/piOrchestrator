import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { DashboardServer } from "./dashboard.js";
import type { AgentInspection, AgentTranscript, ArtifactContent, OrchestratorViewModel } from "./types.js";

const emptyProvider = {
  getViewModel: () => undefined,
  getAgentInspection: async (_name: string) => undefined,
  readArtifact: async (_name: string) => undefined,
};

const testAgent: AgentInspection = {
  name: "planner",
  status: "succeeded",
  model: "gpt-4",
  summary: "Planned the work",
  steps: [],
  toolEvents: [],
  hasArtifact: false,
  hasRawArtifact: false,
};

const testArtifact: ArtifactContent = {
  name: "test.json",
  text: '{"key": "value"}',
  truncated: false,
  isJson: true,
  size: 15,
};

const testTranscript: AgentTranscript = {
  schemaVersion: 1,
  messages: [{ role: "user", content: [{ type: "text", text: "Inspect this repository" }] }],
  truncated: false
};

const sampleViewModel: OrchestratorViewModel = {
  mode: "running",
  cwd: "/test",
  config: { status: "valid", agentCount: 1, checkCount: 1 },
  agents: [],
  recentSteps: [],
  commands: [],
  run: { id: "test-123", request: "test", runStatus: "running", stage: "exploring", phaseIndex: 1, phaseCount: 8, attempt: 1, maxAttempts: 1, elapsedMs: 0, artifactPath: "/test/.pi/runs/test-123" }
};

const idleViewModel: OrchestratorViewModel = {
  mode: "idle",
  cwd: "/project",
  config: { status: "valid", agentCount: 7, checkCount: 3 },
  agents: [],
  recentSteps: [],
  commands: []
};

const configErrorViewModel: OrchestratorViewModel = {
  mode: "config_error",
  cwd: "/project",
  config: { status: "invalid", agentCount: 7, checkCount: 0, message: "Could not parse config" },
  agents: [],
  recentSteps: [],
  commands: []
};

function providerWith(vm: OrchestratorViewModel | undefined, agent?: AgentInspection, artifact?: ArtifactContent) {
  return {
    getViewModel: () => vm,
    getAgentInspection: async (_name: string) => agent ?? testAgent,
    getAgentTranscript: async (_stepId: string, _invocation: number) => testTranscript,
    readArtifact: async (_name: string) => artifact ?? testArtifact,
  };
}

async function server(): Promise<{ dashboard: DashboardServer; url: string }> {
  const dashboard = new DashboardServer(emptyProvider);
  const url = await dashboard.start(0);
  return { dashboard, url };
}

describe("DashboardServer", () => {
  it("starts on a local port and returns a URL", async () => {
    const { dashboard, url } = await server();
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    await dashboard.stop();
  });

  it("serves HTML at / and JSON at /api/state", async () => {
    const { dashboard, url } = await server();
    const htmlResponse = await fetch(url);
    expect(htmlResponse.status).toBe(200);
    const html = await htmlResponse.text();
    expect(html).toContain("piOrchestrator");
    expect(html).toContain("Conversation history");
    expect(html).toContain("Thinking");
    const stateResponse = await fetch(`${url}/api/state`);
    expect(stateResponse.status).toBe(200);
    const body = await stateResponse.json();
    expect(body).toBeNull();
    await dashboard.stop();
  });

  it("returns 404 for unmatched routes", async () => {
    const { dashboard, url } = await server();
    const response = await fetch(`${url}/unknown`);
    expect(response.status).toBe(404);
    await dashboard.stop();
  });

  it("publishes view model to SSE clients", async () => {
    const dashboard = new DashboardServer(providerWith(sampleViewModel));
    const url = await dashboard.start(0);
    const sseResponse = await fetch(`${url}/events`);
    const reader = sseResponse.body!.getReader();
    const decoder = new TextDecoder();
    const { value } = await reader.read();
    const text = decoder.decode(value, { stream: true });
    expect(text).toContain("connected");
    expect(text).toContain("test-123");
    reader.cancel();
    await dashboard.stop();
  });

  it("sends published state to SSE clients", async () => {
    const dashboard = new DashboardServer(emptyProvider);
    const url = await dashboard.start(0);
    const sseResponse = await fetch(`${url}/events`);
    const reader = sseResponse.body!.getReader();
    const decoder = new TextDecoder();
    await reader.read();
    dashboard.publish(sampleViewModel);
    const { value } = await reader.read();
    const text = decoder.decode(value, { stream: true });
    expect(text).toContain("test-123");
    reader.cancel();
    await dashboard.stop();
  });

  it("returns lastState from /api/state when provider returns undefined", async () => {
    const dashboard = new DashboardServer(emptyProvider);
    const url = await dashboard.start(0);
    dashboard.publish(sampleViewModel);
    const response = await fetch(`${url}/api/state`);
    const body: OrchestratorViewModel = await response.json();
    expect(body.mode).toBe("running");
    expect(body.run!.id).toBe("test-123");
    await dashboard.stop();
  });

  it("returns null from /api/state when provider and lastState are both undefined", async () => {
    const { dashboard, url } = await server();
    const response = await fetch(`${url}/api/state`);
    const body = await response.json();
    expect(body).toBeNull();
    await dashboard.stop();
  });

  it("stops without error when not started", async () => {
    const dashboard = new DashboardServer(emptyProvider);
    await expect(dashboard.stop()).resolves.toBeUndefined();
  });

  it("stops correctly when already stopped", async () => {
    const { dashboard } = await server();
    await dashboard.stop();
    await expect(dashboard.stop()).resolves.toBeUndefined();
  });

  it("idempotent start returns same URL", async () => {
    const { dashboard, url } = await server();
    const second = await dashboard.start(0);
    expect(second).toBe(url);
    await dashboard.stop();
  });

  it("sets security headers on / and /api/state", async () => {
    const { dashboard, url } = await server();
    const htmlResponse = await fetch(url);
    expect(htmlResponse.headers.get("x-content-type-options")).toBe("nosniff");
    expect(htmlResponse.headers.get("cache-control")).toBe("no-store");
    const stateResponse = await fetch(`${url}/api/state`);
    expect(stateResponse.headers.get("x-content-type-options")).toBe("nosniff");
    await dashboard.stop();
  });

  it("rejects non-loopback origins", async () => {
    const { dashboard, url } = await server();
    const hostileOrigin = await fetch(url, { headers: { origin: "https://attacker.example" } });
    expect(hostileOrigin.status).toBe(403);
    await dashboard.stop();
  });

  it("returns agent inspection at /api/agents/:name", async () => {
    const dashboard = new DashboardServer(providerWith(undefined, testAgent));
    const url = await dashboard.start(0);
    const response = await fetch(`${url}/api/agents/planner`);
    expect(response.status).toBe(200);
    const body: AgentInspection = await response.json();
    expect(body.name).toBe("planner");
    expect(body.status).toBe("succeeded");
    await dashboard.stop();
  });

  it("returns a step invocation transcript", async () => {
    const dashboard = new DashboardServer(providerWith(undefined));
    const url = await dashboard.start(0);
    const response = await fetch(`${url}/api/steps/step-001/invocations/1/transcript`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(testTranscript);
    await dashboard.stop();
  });

  it("rejects malformed transcript routes", async () => {
    const dashboard = new DashboardServer(providerWith(undefined));
    const url = await dashboard.start(0);
    expect((await fetch(`${url}/api/steps/../invocations/1/transcript`)).status).toBe(404);
    expect((await fetch(`${url}/api/steps/step-001/invocations/not-a-number/transcript`)).status).toBe(404);
    await dashboard.stop();
  });

  it("returns null for unknown agent", async () => {
    const dashboard = new DashboardServer(emptyProvider);
    const url = await dashboard.start(0);
    const response = await fetch(`${url}/api/agents/unknown`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toBeNull();
    await dashboard.stop();
  });

  it("returns artifact content at /api/artifacts/:name", async () => {
    const dashboard = new DashboardServer(providerWith(undefined, undefined, testArtifact));
    const url = await dashboard.start(0);
    const response = await fetch(`${url}/api/artifacts/test.json`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const text = await response.text();
    expect(text).toBe('{"key": "value"}');
    await dashboard.stop();
  });

  it("includes artifact size and truncation headers", async () => {
    const dashboard = new DashboardServer(providerWith(undefined, undefined, testArtifact));
    const url = await dashboard.start(0);
    const response = await fetch(`${url}/api/artifacts/test.json`);
    expect(response.headers.get("x-artifact-size")).toBe("15");
    expect(response.headers.get("x-artifact-truncated")).toBe("false");
    await dashboard.stop();
  });

  it("returns 404 for unknown artifact", async () => {
    const dashboard = new DashboardServer(emptyProvider);
    const url = await dashboard.start(0);
    const response = await fetch(`${url}/api/artifacts/missing.json`);
    expect(response.status).toBe(404);
    await dashboard.stop();
  });

  it("prevents path traversal in artifact names", async () => {
    let capturedName = "";
    const provider = {
      getViewModel: () => undefined,
      getAgentInspection: async (_name: string) => undefined,
      readArtifact: async (name: string) => {
        capturedName = name;
        return undefined;
      },
    };
    const dashboard = new DashboardServer(provider);
    const url = await dashboard.start(0);
    await fetch(`${url}/api/artifacts/safe%2F..%2F..%2Fpasswd`);
    expect(capturedName).toBe("passwd");
    await dashboard.stop();
  });

  it("inline script in served HTML is syntactically valid JavaScript", async () => {
    const { dashboard, url } = await server();
    const htmlResponse = await fetch(url);
    const html = await htmlResponse.text();
    const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
    expect(scriptMatch).not.toBeNull();
    const scriptContent = scriptMatch![1];
    expect(() => { new vm.Script(scriptContent); }).not.toThrow();
    await dashboard.stop();
  });

  it("returns valid JSON from /api/state when provider throws", async () => {
    const throwingProvider = {
      getViewModel: () => { throw new Error("test error"); },
      getAgentInspection: async (_name: string) => undefined,
      readArtifact: async (_name: string) => undefined,
    };
    const dashboard = new DashboardServer(throwingProvider);
    const url = await dashboard.start(0);
    const response = await fetch(`${url}/api/state`);
    expect(response.status).toBe(500);
    await dashboard.stop();
  });

  it("renders idle view model at /api/state", async () => {
    const dashboard = new DashboardServer(providerWith(idleViewModel));
    const url = await dashboard.start(0);
    const response = await fetch(`${url}/api/state`);
    const body: OrchestratorViewModel = await response.json();
    expect(body.mode).toBe("idle");
    expect(body.config.agentCount).toBe(7);
    await dashboard.stop();
  });

  it("renders config_error view model at /api/state", async () => {
    const dashboard = new DashboardServer(providerWith(configErrorViewModel));
    const url = await dashboard.start(0);
    const response = await fetch(`${url}/api/state`);
    const body: OrchestratorViewModel = await response.json();
    expect(body.mode).toBe("config_error");
    expect(body.config.message).toBe("Could not parse config");
    await dashboard.stop();
  });
});
