import type { ExtensionCommandContext, TerminalInputHandler } from "@earendil-works/pi-coding-agent";
import type { QuestionChannel } from "./requirements-command.js";

const ARROW_UP = "\x1b[A";
const ARROW_DOWN = "\x1b[B";
const ARROW_RIGHT = ["\x1b[C", "\x1bOC"];
const ARROW_LEFT = ["\x1b[D", "\x1bOD"];

/**
 * Phase C: translates TUI arrow keys while the question hub or an answer
 * dialog is open, so the arrow keys do something useful during the
 * requirements interview.
 *
 * - Answer dialog open: Right/Left are consumed entirely and turned into
 *   next/previous question-switch requests. The dialog's select-list only
 *   binds Up/Down, so the keys would otherwise do nothing.
 * - Question hub open: Right/Left are rewritten to Down/Up so the hub's
 *   select-list moves to the next/previous question.
 */
export class RequirementsArrowTranslator {
  private unsubscribe: (() => void) | undefined;
  private hubOpen = false;
  private dialogChannel: QuestionChannel | undefined;

  constructor(
    private readonly ctx: ExtensionCommandContext,
    private readonly requestSwitchAction: (channel: QuestionChannel, target: "next" | "previous") => void
  ) {}

  /** Registers the terminal input listener; a no-op while already registered. */
  register(): void {
    if (this.unsubscribe !== undefined) return;
    const onTerminalInput = this.ctx.ui?.onTerminalInput;
    if (onTerminalInput === undefined) return;
    this.unsubscribe = onTerminalInput.call(this.ctx.ui, (data: string) => this.translate(data));
  }

  /** Unregisters the terminal input listener and resets the open-dialog state. */
  unregister(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.hubOpen = false;
    this.dialogChannel = undefined;
  }

  /** Marks the round's question hub as open (or closed). */
  setHubOpen(open: boolean): void {
    this.hubOpen = open;
    if (!open) this.dialogChannel = undefined;
  }

  /** Marks the channel whose answer dialog is currently open (or none). */
  setDialogChannel(channel: QuestionChannel | undefined): void {
    this.dialogChannel = channel;
  }

  private translate(data: string): ReturnType<TerminalInputHandler> {
    const channel = this.dialogChannel;
    if (channel !== undefined) {
      if (ARROW_RIGHT.includes(data)) {
        this.requestSwitchAction(channel, "next");
        return { consume: true };
      }
      if (ARROW_LEFT.includes(data)) {
        this.requestSwitchAction(channel, "previous");
        return { consume: true };
      }
      return undefined;
    }
    if (this.hubOpen) {
      if (ARROW_RIGHT.includes(data)) return { data: ARROW_DOWN };
      if (ARROW_LEFT.includes(data)) return { data: ARROW_UP };
    }
    return undefined;
  }
}
