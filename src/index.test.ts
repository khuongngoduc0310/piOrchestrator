import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ORCHESTRATE_USAGE, WORKFLOW_ROUTE_CHOICES } from "./commands/route-selection.js";

const mocks = vi.hoisted(() => ({
  engine: {
    cancel: vi.fn(() => false),
    getState: vi.fn(),
    isRunning: vi.fn(() => false),
    setOnStateChange: vi.fn(),
    shutdown: vi.fn(async () => undefined),
    start: vi.fn(async () => undefined)
  },
  ui: {
    attach: vi.fn(async () => undefined),
    detach: vi.fn(),
    updateRun: vi.fn()
  }
}));

vi.mock("./orchestrator.js", () => ({
  Orchestrator: class {
    constructor() {
      return mocks.engine;
    }
  }
}));

vi.mock("./ui/ui-controller.js", () => ({
  UiController: class {
    constructor() {
      return mocks.ui;
    }
  }
}));

import piOrchestrator from "./index.js";

type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;
type EventHandler = (event: unknown, ctx: ExtensionCommandContext) => Promise<void>;

function registeredExtension() {
  const commands = new Map<string, CommandHandler>();
  const events = new Map<string, EventHandler>();
  const pi = {
    on: vi.fn((name: string, handler: EventHandler) => events.set(name, handler)),
    registerCommand: vi.fn((name: string, command: { handler: CommandHandler }) => commands.set(name, command.handler))
  } as unknown as ExtensionAPI;

  piOrchestrator(pi);

  return {
    command(name: string): CommandHandler {
      const handler = commands.get(name);
      if (!handler) throw new Error(`Command was not registered: ${name}`);
      return handler;
    },
    event(name: string): EventHandler {
      const handler = events.get(name);
      if (!handler) throw new Error(`Event was not registered: ${name}`);
      return handler;
    }
  };
}

function commandContext(options: { routeLabel?: string; request?: string } = {}) {
  const notify = vi.fn();
  const select = vi.fn(async () => options.routeLabel);
  const input = vi.fn(async () => options.request);
  const ctx = {
    cwd: "C:\\project",
    hasUI: true,
    ui: { input, notify, select }
  } as unknown as ExtensionCommandContext;
  return { ctx, input, notify, select };
}

describe("extension command and lifecycle registration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.engine.cancel.mockReturnValue(false);
    mocks.engine.start.mockResolvedValue(undefined);
    mocks.engine.shutdown.mockResolvedValue(undefined);
  });

  it("rejects /orchestrate arguments without collecting or starting a workflow", async () => {
    const extension = registeredExtension();
    const context = commandContext();

    await extension.command("orchestrate")("unexpected", context.ctx);

    expect(context.notify).toHaveBeenCalledWith(`Usage: ${ORCHESTRATE_USAGE}`, "warning");
    expect(context.select).not.toHaveBeenCalled();
    expect(context.input).not.toHaveBeenCalled();
    expect(mocks.engine.start).not.toHaveBeenCalled();
  });

  it("collects the selected route and request before starting the workflow", async () => {
    const extension = registeredExtension();
    const choice = WORKFLOW_ROUTE_CHOICES.find(item => item.route === "implementation")!;
    const context = commandContext({ routeLabel: choice.label, request: "  implement the feature  " });

    await extension.command("orchestrate")("", context.ctx);

    expect(context.select).toHaveBeenCalledWith("Select a workflow route", WORKFLOW_ROUTE_CHOICES.map(item => item.label));
    expect(context.input).toHaveBeenCalledWith("Describe the request for implementation");
    expect(mocks.engine.start).toHaveBeenCalledWith(
      { route: "implementation", request: "implement the feature" },
      context.ctx
    );
  });

  it("attaches on session start and detaches before engine shutdown", async () => {
    const extension = registeredExtension();
    const context = commandContext();

    await extension.event("session_start")({}, context.ctx);
    await extension.event("session_shutdown")({}, context.ctx);

    expect(mocks.ui.attach).toHaveBeenCalledWith(context.ctx);
    expect(mocks.ui.detach).toHaveBeenCalledWith(context.ctx);
    expect(mocks.engine.shutdown).toHaveBeenCalledWith(context.ctx);
    expect(mocks.ui.detach.mock.invocationCallOrder[0]).toBeLessThan(mocks.engine.shutdown.mock.invocationCallOrder[0]);
  });

  it.each([
    [true, "Cancellation requested", "warning"],
    [false, "No active workflow to cancel", "info"]
  ] as const)("reports cancellation result %s truthfully", async (requested, message, level) => {
    mocks.engine.cancel.mockReturnValue(requested);
    const extension = registeredExtension();
    const context = commandContext();

    await extension.command("orchestrator-cancel")("", context.ctx);

    expect(mocks.engine.cancel).toHaveBeenCalledOnce();
    expect(context.notify).toHaveBeenCalledWith(message, level);
  });

  it("notifies the user when starting a workflow throws", async () => {
    mocks.engine.start.mockRejectedValueOnce(new Error("start failed"));
    const extension = registeredExtension();
    const choice = WORKFLOW_ROUTE_CHOICES.find(item => item.route === "review_only")!;
    const context = commandContext({ routeLabel: choice.label, request: "review this" });

    await extension.command("orchestrate")("", context.ctx);

    expect(context.notify).toHaveBeenCalledWith("start failed", "error");
  });
});
