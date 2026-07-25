import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ORCHESTRATE_USAGE, WORKFLOW_ROUTE_CHOICES } from "./commands/route-selection.js";

const mocks = vi.hoisted(() => ({
  engine: {
    cancel: vi.fn(() => false),
    getState: vi.fn(),
    isRunning: vi.fn(() => false),
    resume: vi.fn(async (): Promise<void> => undefined),
    setOnStateChange: vi.fn(),
    shutdown: vi.fn(async (): Promise<void> => undefined),
    start: vi.fn(async (): Promise<void> => {}),
  },
  ui: {
    attach: vi.fn(async () => undefined),
    detach: vi.fn(),
    openMissionControl: vi.fn(async () => undefined),
    updateRun: vi.fn(),
  },
}));

vi.mock("./orchestrator.js", () => ({
  Orchestrator: class {
    constructor() {
      return mocks.engine;
    }
  },
}));

vi.mock("./ui/ui-controller.js", () => ({
  UiController: class {
    constructor() {
      return mocks.ui;
    }
  },
}));

import piOrchestrator from "./index.js";

type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;
type EventHandler = (event: unknown, ctx: ExtensionCommandContext) => Promise<void>;

function registeredExtension() {
  const commands = new Map<string, CommandHandler>();
  const events = new Map<string, EventHandler>();
  const pi = {
    on: vi.fn((name: string, handler: EventHandler) => events.set(name, handler)),
    registerCommand: vi.fn(
      (name: string, command: { handler: CommandHandler }) => commands.set(name, command.handler),
    ),
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
    },
  };
}

function commandContext(options: { routeLabel?: string; request?: string } = {}) {
  const notify = vi.fn();
  const select = vi.fn(async () => options.routeLabel);
  const input = vi.fn(async () => options.request);
  const ctx = {
    cwd: "C:\\project",
    hasUI: true,
    ui: { input, notify, select },
  } as unknown as ExtensionCommandContext;
  return { ctx, input, notify, select };
}

function deferrable(): { promise: Promise<undefined>; resolve: () => void; reject: (err: Error) => void } {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<undefined>((res, rej) => {
    resolve = () => res(undefined);
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("extension command and lifecycle registration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.engine.cancel.mockReturnValue(false);
    mocks.engine.start.mockResolvedValue(undefined as unknown as void);
    mocks.engine.shutdown.mockResolvedValue(undefined as unknown as void);
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

  it("starts the workflow in the background so the command returns immediately", async () => {
    const deferred = deferrable();
    mocks.engine.start.mockReturnValue(deferred.promise);

    const extension = registeredExtension();
    const choice = WORKFLOW_ROUTE_CHOICES.find(item => item.route === "implementation")!;
    const context = commandContext({ routeLabel: choice.label, request: "feat" });

    await extension.command("orchestrate")("", context.ctx);

    expect(mocks.engine.start).toHaveBeenCalledWith(
      { route: "implementation", request: "feat" },
      context.ctx,
    );

    // Command returned while the workflow is still running.
    deferred.resolve();
  });

  it("allows /orchestrator-control during a background workflow", async () => {
    const deferred = deferrable();
    mocks.engine.start.mockReturnValue(deferred.promise);

    const extension = registeredExtension();
    const choice = WORKFLOW_ROUTE_CHOICES.find(item => item.route === "implementation")!;
    const startCtx = commandContext({ routeLabel: choice.label, request: "feat" });

    await extension.command("orchestrate")("", startCtx.ctx);

    const controlCtx = commandContext();
    await extension.command("orchestrator-control")("", controlCtx.ctx);

    expect(mocks.ui.openMissionControl).toHaveBeenCalledWith(controlCtx.ctx);
    deferred.resolve();
  });

  it("allows /orchestrator-cancel during a background workflow", async () => {
    const deferred = deferrable();
    mocks.engine.start.mockReturnValue(deferred.promise);

    const extension = registeredExtension();
    const choice = WORKFLOW_ROUTE_CHOICES.find(item => item.route === "implementation")!;
    const startCtx = commandContext({ routeLabel: choice.label, request: "feat" });

    await extension.command("orchestrate")("", startCtx.ctx);

    await extension.command("orchestrator-cancel")("", startCtx.ctx);

    expect(mocks.engine.cancel).toHaveBeenCalledOnce();
    deferred.resolve();
  });

  it("notifies the user when a background workflow fails to start", async () => {
    const deferred = deferrable();
    mocks.engine.start.mockReturnValue(deferred.promise);

    const extension = registeredExtension();
    const choice = WORKFLOW_ROUTE_CHOICES.find(item => item.route === "review_only")!;
    const context = commandContext({ routeLabel: choice.label, request: "review this" });

    await extension.command("orchestrate")("", context.ctx);

    deferred.reject(new Error("config unavailable"));
    // Let the rejection propagate to the observer.
    await vi.waitFor(() => {
      expect(context.notify).toHaveBeenCalledWith("Workflow could not start: config unavailable", "error");
    });
  });

  it("launches resume in the background", async () => {
    const deferred = deferrable();
    mocks.engine.resume.mockReturnValue(deferred.promise);

    const extension = registeredExtension();
    const context = commandContext();

    await extension.command("orchestrator-resume")("run-abc", context.ctx);

    expect(mocks.engine.resume).toHaveBeenCalledWith("run-abc", context.ctx);
    deferred.resolve();
  });

  it("notifies when a background resume fails", async () => {
    const deferred = deferrable();
    mocks.engine.resume.mockReturnValue(deferred.promise);

    const extension = registeredExtension();
    const context = commandContext();

    await extension.command("orchestrator-resume")("run-abc", context.ctx);

    deferred.reject(new Error("checkpoint expired"));
    await vi.waitFor(() => {
      expect(context.notify).toHaveBeenCalledWith("Resume failed: checkpoint expired", "error");
    });
  });

  it("attaches on session start and detaches before engine shutdown", async () => {
    const extension = registeredExtension();
    const context = commandContext();

    await extension.event("session_start")({}, context.ctx);
    await extension.event("session_shutdown")({}, context.ctx);

    expect(mocks.ui.attach).toHaveBeenCalledWith(context.ctx);
    expect(mocks.ui.detach).toHaveBeenCalledWith(context.ctx);
    expect(mocks.engine.shutdown).toHaveBeenCalledWith(context.ctx);
    expect(mocks.ui.detach.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.engine.shutdown.mock.invocationCallOrder[0],
    );
  });

  it.each([
    [true, "Cancellation requested", "warning"],
    [false, "No active workflow to cancel", "info"],
  ] as const)("reports cancellation result %s truthfully", async (requested, message, level) => {
    mocks.engine.cancel.mockReturnValue(requested);
    const extension = registeredExtension();
    const context = commandContext();

    await extension.command("orchestrator-cancel")("", context.ctx);

    expect(mocks.engine.cancel).toHaveBeenCalledOnce();
    expect(context.notify).toHaveBeenCalledWith(message, level);
  });
});
