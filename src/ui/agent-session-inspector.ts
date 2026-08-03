import { visibleWidth, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { AgentName } from "../agent-types.js";
import { elapsedText } from "./ui-model.js";
import type { AgentSessionEvent, AgentSessionView } from "./agent-session.js";
import { isAssistantJson } from "./agent-session.js";
import { renderStructuredAgentResponse } from "./structured-agent-response.js";

export interface InspectorOptions {
  agent: AgentName | null;
  followFromBottom: number;
  expandedTools: boolean;
}

type Th = { fg(color: string, text: string): string; bold(text: string): string };

function accent(th: Th, t: string) { return th.fg("accent", t); }
function success(th: Th, t: string) { return th.fg("success", t); }
function errorCol(th: Th, t: string) { return th.fg("error", t); }
function muted(th: Th, t: string) { return th.fg("muted", t); }
function dim(th: Th, t: string) { return th.fg("dim", t); }
function border(th: Th, t: string) { return th.fg("borderMuted", t); }

function eventSymbol(event: AgentSessionEvent, th: Th): string {
  switch (event.type) {
    case "assistant":
    case "structured_response":
      return muted(th, "\u25d8");
    case "tool_call": {
      switch (event.status) {
        case "running": return accent(th, "\u2192");
        case "succeeded": return success(th, "\u2713");
        case "failed": return errorCol(th, "\u2717");
      }
      break;
    }
    case "system": {
      if (event.kind === "retry") {
        const w = (s: string) => th.fg("warning", s);
        return w("\u21bb");
      }
      if (event.kind === "agent_start") return muted(th, "\u25b6");
      if (event.kind === "agent_end") return muted(th, "\u25a0");
      return muted(th, "\u25a1");
    }
  }
}

function pad(w: number, s: string): string {
  const pw = visibleWidth(s);
  return pw >= w ? s : s + " ".repeat(w - pw);
}

function padCenter(s: string, w: number): string {
  const pw = visibleWidth(s);
  if (pw >= w) return s;
  const left = Math.floor((w - pw) / 2);
  return " ".repeat(left) + s + " ".repeat(w - pw - left);
}

export function renderInspectorScreen(
  width: number,
  view: AgentSessionView | undefined,
  options: InspectorOptions,
  agentNames: string[],
  th: Th,
): string[] {
  const inner = Math.max(10, width - 2);
  const lines: string[] = [];
  const agentLabel = options.agent ?? "\u2014";

  const header = `${accent(th, `piOrchestrator \u00b7 ${agentLabel}`)}`;
  const topFiller = Math.max(0, width - visibleWidth(header) - 4);
  lines.push(border(th, "\u250c ") + header + border(th, " " + "\u2500".repeat(topFiller) + "\u2510"));

  if (!view) {
    lines.push(border(th, "\u2502") + " ".repeat(inner) + border(th, "\u2502"));
    lines.push(border(th, "\u2502") + muted(th, padCenter("No agent session data available", inner)) + border(th, "\u2502"));
    lines.push(border(th, "\u2514" + "\u2500".repeat(inner) + "\u2518"));
    return lines;
  }

  lines.push(border(th, "\u2502") + pad(inner, `${dim(th, agentLabel)} ${muted(th, "\u00b7")} ${dim(th, "events: " + view.events.length)}`) + border(th, "\u2502"));
  lines.push(border(th, "\u2502") + muted(th, "\u2500".repeat(inner)) + border(th, "\u2502"));

  const visibleEvents = getVisibleEvents(view, options);
  for (const ev of visibleEvents) {
    const sym = eventSymbol(ev, th);
    renderEventBlock(ev, sym, th, inner, lines);
  }

  if (visibleEvents.length === 0) {
    lines.push(border(th, "\u2502") + " ".repeat(inner) + border(th, "\u2502"));
    lines.push(border(th, "\u2502") + muted(th, padCenter("No events yet", inner)) + border(th, "\u2502"));
  }

  lines.push(border(th, "\u2502") + muted(th, "\u2500".repeat(inner)) + border(th, "\u2502"));
  const following = options.followFromBottom <= 0;
  const followTxt = following ? success(th, "on") : muted(th, "off");
  const toolTxt = options.expandedTools ? success(th, "on") : muted(th, "off");
  const footer = `${muted(th, "\u2191\u2193 Scroll")}  [f] Follow: ${followTxt}  [t] Tool: ${toolTxt}  ${muted(th, "[Tab] Agent")}  ${muted(th, "[Esc] Dashboard")}`;
  lines.push(border(th, "\u2502") + pad(inner, muted(th, truncateToWidth(footer, inner))) + border(th, "\u2502"));
  lines.push(border(th, "\u2514" + "\u2500".repeat(inner) + "\u2518"));

  return lines;
}

function getVisibleEvents(view: AgentSessionView, opts: InspectorOptions): AgentSessionEvent[] {
  const all = view.events;
  const tail = 20;
  if (opts.followFromBottom <= 0 || all.length <= tail) {
    return all.length <= tail ? all.slice() : all.slice(-tail);
  }
  const offset = Math.min(opts.followFromBottom, all.length - 1);
  const end = all.length - offset;
  const start = Math.max(0, end - tail);
  return all.slice(start, end);
}

function renderEventBlock(
  event: AgentSessionEvent,
  sym: string,
  th: Th,
  maxWidth: number,
  lines: string[],
): void {
  const inner = maxWidth;
  const indent = "  ";
  const prefix = `${sym} `;

  function addRow(content: string): void {
    const trimmed = truncateToWidth(content, inner);
    lines.push("\u2502" + pad(inner, trimmed) + "\u2502");
  }

  switch (event.type) {
    case "assistant": {
      if (isAssistantJson(event.text)) {
        addRow(`${prefix}${muted(th, "Preparing structured response...")}`);
      } else {
        const wrapped = wrapTextWithAnsi(event.text, inner - 8);
        if (wrapped.length === 0) {
          addRow(`${prefix}${muted(th, "(empty)")}`);
        } else {
          addRow(`${prefix}${wrapped[0]}`);
          for (let i = 1; i < wrapped.length; i++) {
            addRow(`${indent}${wrapped[i]}`);
          }
        }
      }
      break;
    }
    case "structured_response": {
      addRow(`${prefix}${accent(th, "Response")}`);
      const rendered = renderStructuredAgentResponse(event.response, th);
      for (const r of rendered) {
        const trimmed = truncateToWidth(r, inner);
        lines.push("\u2502" + pad(inner, trimmed) + "\u2502");
      }
      break;
    }
    case "tool_call": {
      const toolLabel = `${sym} ${accent(th, event.tool)}`;
      addRow(toolLabel);
      if (event.args || event.result) {
        addRow(`${indent}${muted(th, event.args ?? "")}`);
      }
      if (event.status !== "running") {
        const st = event.status === "succeeded" ? success(th, "\u2713 completed") : errorCol(th, "\u2717 failed");
        const duration = event.durationMs ? ` \u00b7 ${elapsedText(event.durationMs)}` : "";
        addRow(`${indent}${st}${duration}`);
      }
      if (event.result) {
        const visible = truncateToWidth(event.result.replace(/\n/g, " "), inner - 6);
        addRow(`${indent}${dim(th, visible)}`);
      }
      break;
    }
    case "system": {
      addRow(`${prefix}${muted(th, event.text)}`);
      break;
    }
  }

  lines.push("\u2502" + " ".repeat(inner) + "\u2502");
}
