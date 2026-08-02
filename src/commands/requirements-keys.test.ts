import { describe, expect, it, vi } from "vitest";
import type { ExtensionCommandContext, TerminalInputHandler } from "@earendil-works/pi-coding-agent";
import type { QuestionChannel } from "./requirements-channel-types.js";
import { RequirementsArrowTranslator } from "./requirements-keys.js";

const ARROW_UP = "\x1b[A";
const ARROW_DOWN = "\x1b[B";
const ARROW_RIGHT = "\x1b[C";
const ARROW_LEFT = "\x1b[D";
const APP_ARROW_RIGHT = "\x1bOC";
const APP_ARROW_LEFT = "\x1bOD";

interface Fixture {
  handlers: TerminalInputHandler[];
  requestSwitchAction: ReturnType<typeof vi.fn>;
  translator: RequirementsArrowTranslator;
}

function fixture(ui = {}): Fixture {
  const handlers: TerminalInputHandler[] = [];
  const onTerminalInput = vi.fn((handler: TerminalInputHandler) => {
    handlers.push(handler);
    return () => {
      const index = handlers.indexOf(handler);
      if (index !== -1) handlers.splice(index, 1);
    };
  });
  const ctx = { hasUI: true, ui: { onTerminalInput, ...ui } } as unknown as ExtensionCommandContext;
  const requestSwitchAction = vi.fn();
  const translator = new RequirementsArrowTranslator(ctx, requestSwitchAction);
  return { handlers, requestSwitchAction, translator };
}

function channel(): QuestionChannel {
  return {} as QuestionChannel;
}

describe("RequirementsArrowTranslator", () => {
  it("passes other keys through untouched", () => {
    const { handlers, translator } = fixture();
    translator.register();
    translator.setHubOpen(true);
    expect(handlers[0](ARROW_UP)).toBeUndefined();
    expect(handlers[0](ARROW_DOWN)).toBeUndefined();
    expect(handlers[0]("a")).toBeUndefined();
    expect(handlers[0]("\x1b[3~")).toBeUndefined();
  });

  it("rewrites Right/Left to Down/Up while the hub is open", () => {
    const { handlers, translator } = fixture();
    translator.register();
    translator.setHubOpen(true);
    translator.setHubListCount(3);
    translator.setHubPosition(1);
    expect(handlers[0](ARROW_RIGHT)).toEqual({ data: ARROW_DOWN });
    expect(handlers[0](APP_ARROW_RIGHT)).toEqual({ data: ARROW_DOWN });
    expect(handlers[0](ARROW_LEFT)).toEqual({ data: ARROW_UP });
    expect(handlers[0](APP_ARROW_LEFT)).toEqual({ data: ARROW_UP });
  });

  it("clamps hub arrows at the ends so they never reach the trailing Cancel entry", () => {
    const { handlers, translator } = fixture();
    translator.register();
    translator.setHubOpen(true);
    translator.setHubListCount(2);
    translator.setHubPosition(1);
    expect(handlers[0](ARROW_RIGHT)).toEqual({ consume: true });
    expect(handlers[0](ARROW_LEFT)).toEqual({ data: ARROW_UP });
    translator.setHubPosition(0);
    expect(handlers[0](ARROW_LEFT)).toEqual({ consume: true });
    expect(handlers[0](ARROW_RIGHT)).toEqual({ data: ARROW_DOWN });
  });

  it("does not rewrite arrows when neither hub nor dialog is open", () => {
    const { handlers, translator } = fixture();
    translator.register();
    expect(handlers[0](ARROW_RIGHT)).toBeUndefined();
    expect(handlers[0](ARROW_LEFT)).toBeUndefined();
  });

  it("consumes Right/Left while the answer dialog is open and requests the switch", () => {
    const { handlers, translator, requestSwitchAction } = fixture();
    translator.register();
    const answered = channel();
    translator.setDialogChannel(answered);
    expect(handlers[0](ARROW_RIGHT)).toEqual({ consume: true });
    expect(requestSwitchAction).toHaveBeenCalledWith(answered, "next");
    expect(handlers[0](APP_ARROW_LEFT)).toEqual({ consume: true });
    expect(requestSwitchAction).toHaveBeenCalledWith(answered, "previous");
  });

  it("leaves arrows native while the custom-answer input is open", () => {
    const { handlers, translator, requestSwitchAction } = fixture();
    translator.register();
    const answered = channel();
    answered.customInputOpen = true;
    translator.setDialogChannel(answered);
    expect(handlers[0](ARROW_RIGHT)).toBeUndefined();
    expect(handlers[0](ARROW_LEFT)).toBeUndefined();
    expect(handlers[0](APP_ARROW_RIGHT)).toBeUndefined();
    expect(requestSwitchAction).not.toHaveBeenCalled();
  });

  it("lets Up/Down and other keys pass through while the answer dialog is open", () => {
    const { handlers, translator, requestSwitchAction } = fixture();
    translator.register();
    translator.setDialogChannel(channel());
    expect(handlers[0](ARROW_UP)).toBeUndefined();
    expect(handlers[0](ARROW_DOWN)).toBeUndefined();
    expect(handlers[0]("Enter")).toBeUndefined();
    expect(requestSwitchAction).not.toHaveBeenCalled();
  });

  it("gives the answer dialog precedence over the hub", () => {
    const { handlers, translator, requestSwitchAction } = fixture();
    translator.register();
    translator.setHubOpen(true);
    translator.setDialogChannel(channel());
    expect(handlers[0](ARROW_RIGHT)).toEqual({ consume: true });
    expect(handlers[0](ARROW_LEFT)).toEqual({ consume: true });
    expect(requestSwitchAction).toHaveBeenCalledTimes(2);
  });

  it("falls back to hub rewrites when the dialog closes", () => {
    const { handlers, translator } = fixture();
    translator.register();
    translator.setHubOpen(true);
    translator.setHubListCount(3);
    translator.setHubPosition(1);
    translator.setDialogChannel(channel());
    translator.setDialogChannel(undefined);
    expect(handlers[0](ARROW_RIGHT)).toEqual({ data: ARROW_DOWN });
  });

  it("registers once and unregisters the listener", () => {
    const { handlers, translator } = fixture();
    translator.register();
    translator.register();
    expect(handlers).toHaveLength(1);
    translator.unregister();
    expect(handlers).toHaveLength(0);
    translator.register();
    expect(handlers).toHaveLength(1);
  });

  it("unregister resets the open-dialog state", () => {
    const { handlers, translator, requestSwitchAction } = fixture();
    translator.register();
    translator.setDialogChannel(channel());
    translator.unregister();
    translator.register();
    expect(handlers[0](ARROW_RIGHT)).toBeUndefined();
    expect(requestSwitchAction).not.toHaveBeenCalled();
  });

  it("is a no-op when the UI context has no onTerminalInput", () => {
    const ctx = { hasUI: true, ui: {} } as unknown as ExtensionCommandContext;
    const translator = new RequirementsArrowTranslator(ctx, vi.fn());
    expect(() => translator.register()).not.toThrow();
    translator.setHubOpen(true);
    translator.unregister();
  });
});
