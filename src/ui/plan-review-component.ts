import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { PlannerOutput } from "../agent-task-types.js";
import { topologicalSort } from "../orchestration/plan-review.js";

export type PlanReviewResult =
  | { action: "approve" }
  | { action: "request_changes" }
  | { action: "cancel" };

const enum K {
  Enter = "\r",
  Escape = "\x1b",
  Up = "\x1b[A",
  Down = "\x1b[B",
  Left = "\x1b[D",
  Right = "\x1b[C",
  Tab = "\t",
}

function matches(data: string, key: K): boolean {
  return data === key;
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function visibleWidth(text: string): number {
  return stripAnsi(text).length;
}

function wordWrap(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const result: string[] = [];
  for (const para of text.split("\n")) {
    if (para.length === 0) { result.push(""); continue; }
    let start = 0;
    while (start < para.length) {
      let end = Math.min(start + width, para.length);
      if (end < para.length && para[end] !== " " && para[end - 1] !== " ") {
        const space = para.lastIndexOf(" ", end);
        if (space > start) end = space;
      }
      result.push(para.slice(start, end));
      start = end + (para[end] === " " ? 1 : 0);
    }
  }
  return result;
}

function addWrapped(lines: string[], prefix: string, text: string, width: number): void {
  const pw = visibleWidth(prefix);
  const wrapWidth = Math.max(1, width - pw);
  const wrapped = wordWrap(text, wrapWidth);
  const cont = " ".repeat(pw);
  for (let i = 0; i < wrapped.length; i++) {
    lines.push(`${i === 0 ? prefix : cont}${wrapped[i]}`);
  }
}

export function createPlanReviewComponent(
  tui: { requestRender(): void },
  theme: Pick<Theme, "fg" | "bold" | "bg">,
  done: (result: PlanReviewResult) => void,
  plan: PlannerOutput,
  label: string,
): { render(width: number): string[]; handleInput(data: string): void; invalidate(): void } {
  const sections = [
    { collapsed: false },
    { collapsed: false },
    { collapsed: false },
    { collapsed: true },
    { collapsed: true },
  ];
  let mode: "scroll" | "buttons" = "scroll";
  let focusedSection = 0;
  let focusedButton = 0;
  let cachedLines: { width: number; lines: string[] } | undefined;

  const sortedTasks = topologicalSort(plan.tasks);
  const visibleSections = [
    0,
    ...(plan.acceptanceCriteria.length > 0 ? [1] : []),
    ...(sortedTasks.length > 0 ? [2] : []),
    ...(plan.assumptions.length > 0 ? [3] : []),
    ...(plan.risks.length > 0 ? [4] : []),
  ];

  function refresh(): void { cachedLines = undefined; tui.requestRender(); }

  function render(width: number): string[] {
    if (cachedLines && cachedLines.width === width) return cachedLines.lines;
    const lines: string[] = [];
    const pw = width;

    function ln(text: string, color?: ThemeColor): void {
      const t = color ? theme.fg(color, text) : text;
      lines.push(t);
    }

    function sectionHeader(title: string, idx: number, collapsed: boolean, count?: number): void {
      const icon = collapsed ? "[+]" : "[-]";
      const cnt = count !== undefined ? ` (${count})` : "";
      const header = `${icon} ${title}${cnt}`;
      lines.push("");
      if (mode === "scroll" && idx === focusedSection) {
        ln(theme.bg("selectedBg", theme.fg("text", ` ${header} `)));
      } else {
        ln(header, "accent");
      }
      lines.push("");
    }

    function wrapLn(prefix: string, text: string): void {
      addWrapped(lines, prefix, text, pw);
    }

    // Top border
    ln("─".repeat(pw), "accent");

    // Title
    ln(theme.bold(label));
    ln("");

    // Route info
    ln(`Route: ${plan.route}`, "muted");
    ln("");

    // --- Summary (section 0) ---
    sectionHeader("Summary", 0, sections[0].collapsed);
    if (!sections[0].collapsed) {
      for (const para of plan.summary.split("\n")) {
        wrapLn("", para);
      }
      ln("");
    }

    // --- Acceptance Criteria (section 1) ---
    if (plan.acceptanceCriteria.length > 0) {
      sectionHeader("Acceptance Criteria", 1, sections[1].collapsed, plan.acceptanceCriteria.length);
      if (!sections[1].collapsed) {
        for (const c of plan.acceptanceCriteria) {
          wrapLn("  ☐  ", c);
        }
      }
    }

    // --- Tasks (section 2) ---
    if (sortedTasks.length > 0) {
      sectionHeader("Tasks", 2, sections[2].collapsed, sortedTasks.length);
      if (!sections[2].collapsed) {
        for (let i = 0; i < sortedTasks.length; i++) {
          const task = sortedTasks[i];
          wrapLn(`${i + 1}. `, task.id);
          wrapLn("   ", task.description);
          ln("");
          if (task.dependencies.length > 0) {
            const deps = task.dependencies.join(", ");
            wrapLn("   ", `Depends on: ${deps}`);
          }
          if (task.files.length > 0) {
            wrapLn("   ", `Files: ${task.files.join(", ")}`);
          }
          if (task.testSupportFiles && task.testSupportFiles.length > 0) {
            wrapLn("   ", `Test support: ${task.testSupportFiles.join(", ")}`);
          }
          if (task.verification.length > 0) {
            wrapLn("   ", `Verification:`);
            for (const v of task.verification) {
              wrapLn("     • ", v);
            }
          }
          ln("");
        }
      }
    }

    // --- Assumptions (section 3) ---
    if (plan.assumptions.length > 0) {
      sectionHeader("Assumptions", 3, sections[3].collapsed, plan.assumptions.length);
      if (!sections[3].collapsed) {
        for (const a of plan.assumptions) {
          wrapLn("  • ", a);
        }
      }
    }

    // --- Risks (section 4) ---
    if (plan.risks.length > 0) {
      sectionHeader("Risks", 4, sections[4].collapsed, plan.risks.length);
      if (!sections[4].collapsed) {
        for (const r of plan.risks) {
          wrapLn("  • ", r);
        }
      }
    }

    ln("");

    // Button bar
    const buttons = ["Approve", "Changes", "Cancel"];
    const btnParts: string[] = [];
    for (let i = 0; i < buttons.length; i++) {
      const isFocused = mode === "buttons" && i === focusedButton;
      const btnText = ` [${buttons[i]}] `;
      if (isFocused) {
        btnParts.push(theme.bg("selectedBg", theme.fg("text", btnText)));
      } else {
        btnParts.push(theme.fg("muted", btnText));
      }
    }
    ln(btnParts.join(" "));

    // Help footer
    if (mode === "buttons") {
      ln("← → cycle · Enter select · Esc back to scroll", "dim");
    } else {
      ln("↑ ↓ sections · Enter toggle · Tab to buttons · Esc cancel", "dim");
    }

    // Bottom border
    ln("─".repeat(pw), "accent");

    cachedLines = { width, lines };
    return lines;
  }

  function handleInput(data: string): void {
    if (matches(data, K.Escape)) {
      if (mode === "buttons") {
        mode = "scroll";
        refresh();
      } else {
        done({ action: "cancel" });
      }
      return;
    }

    if (mode === "buttons") {
      if (matches(data, K.Left) || matches(data, K.Up) || matches(data, K.Tab)) {
        focusedButton = (focusedButton - 1 + 3) % 3;
        refresh();
        return;
      }
      if (matches(data, K.Right) || matches(data, K.Down)) {
        focusedButton = (focusedButton + 1) % 3;
        refresh();
        return;
      }
      if (matches(data, K.Enter)) {
        if (focusedButton === 0) done({ action: "approve" });
        else if (focusedButton === 1) done({ action: "request_changes" });
        else if (focusedButton === 2) done({ action: "cancel" });
        return;
      }
      return;
    }

    // Scroll mode
    if (matches(data, K.Up) || matches(data, K.Down)) {
      const current = visibleSections.indexOf(focusedSection);
      const direction = matches(data, K.Up) ? -1 : 1;
      focusedSection = visibleSections[(current + direction + visibleSections.length) % visibleSections.length];
      refresh();
      return;
    }
    if (matches(data, K.Enter)) {
      sections[focusedSection].collapsed = !sections[focusedSection].collapsed;
      refresh();
      return;
    }
    if (matches(data, K.Tab)) {
      mode = "buttons";
      focusedButton = 0;
      refresh();
      return;
    }
  }

  return {
    render,
    handleInput,
    invalidate: () => { cachedLines = undefined; },
  };
}
