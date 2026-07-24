import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { getTranscript } from "../api.js";
import type { AgentTranscript } from "../../agent-types.js";

interface TranscriptViewerProps {
  runId: string;
  stepId: string;
  sequence: number;
  query: string;
}

export function TranscriptViewer({
  runId,
  stepId,
  sequence,
  query,
}: TranscriptViewerProps) {
  const [data, setData] = useState<AgentTranscript | null>(null);
  const [error, setError] = useState(false);
  const reqRef = useRef(0);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const scrollPosRef = useRef(0);
  const followTailRef = useRef(true);
  const openDetailsRef = useRef<Set<string>>(new Set());
  const focusedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const req = ++reqRef.current;
    scrollPosRef.current = 0;
    followTailRef.current = true;
    openDetailsRef.current.clear();
    focusedKeyRef.current = null;
    setData(null);
    setError(false);

    getTranscript(runId, stepId, sequence, controller.signal)
      .then((result) => {
        if (req === reqRef.current) {
          setData(result);
        }
      })
      .catch(() => {
        if (req === reqRef.current && !controller.signal.aborted) {
          setError(true);
        }
      });
    return () => controller.abort();
  }, [runId, stepId, sequence]);

  // Record scroll / details / focus before DOM update
  const recordState = useCallback(() => {
    const el = transcriptRef.current;
    if (!el) return;
    scrollPosRef.current = el.scrollTop;
    followTailRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;

    openDetailsRef.current = new Set();
    el.querySelectorAll<HTMLDetailsElement>("details[data-detail-key]").forEach((d) => {
      if (d.open) openDetailsRef.current.add(d.dataset.detailKey ?? "");
    });

    const active = document.activeElement;
    if (active && el.contains(active)) {
      const focused = active.closest<HTMLElement>("[data-detail-key]");
      if (focused) focusedKeyRef.current = focused.dataset.detailKey ?? null;
    }
  }, []);

  // Restore scroll / details / focus after render
  useLayoutEffect(() => {
    const el = transcriptRef.current;
    if (!el || !data) return;

    if (followTailRef.current) {
      el.scrollTop = el.scrollHeight;
    } else {
      el.scrollTop = scrollPosRef.current;
    }

    el.querySelectorAll<HTMLDetailsElement>("details[data-detail-key]").forEach((d) => {
      if (openDetailsRef.current.has(d.dataset.detailKey ?? "")) {
        d.open = true;
      }
    });

    if (focusedKeyRef.current) {
      el.querySelectorAll<HTMLElement>("[data-detail-key]").forEach((d) => {
        if (d.dataset.detailKey === focusedKeyRef.current) {
          const summary = d.querySelector("summary");
          if (summary) summary.focus();
        }
      });
    }
  });

  if (error) {
    return (
      <div className="empty-state">
        Conversation is not available
      </div>
    );
  }

  if (!data) {
    return <div className="empty-state">Loading…</div>;
  }

  return (
    <>
      {data.truncated && (
        <div className="transcript-note">
          Some conversation content was truncated.
        </div>
      )}

      <div className="transcript" ref={transcriptRef} onScroll={recordState}>
        {renderMessages(data, query)}
      </div>
    </>
  );
}

function renderMessages(data: AgentTranscript, query: string) {
  const lowerQuery = query.trim().toLowerCase();
  const messages = data.messages ?? [];

  // Index tool calls
  const calls = new Set<string>();
  for (const msg of messages) {
    for (const part of msg.content ?? []) {
      if (part.type === "toolCall" && part.toolCallId) {
        calls.add(part.toolCallId);
      }
    }
  }

  // Collect results by toolCallId
  const results = new Map<string, AgentTranscript["messages"][number]>();
  for (const msg of messages) {
    if (msg.role === "toolResult" && msg.toolCallId && calls.has(msg.toolCallId)) {
      results.set(msg.toolCallId, msg);
    }
  }

  let messageIndex = 0;
  const elements: React.ReactElement[] = [];

  for (const msg of messages) {
    // Skip duplicate tool results already shown under the tool call
    if (msg.role === "toolResult" && msg.toolCallId && calls.has(msg.toolCallId)) {
      continue;
    }

    const roleClass =
      msg.role === "toolResult" ? "tool-result" : msg.role;
    const errorClass = msg.isError ? " error" : "";
    const boxChildren: React.ReactNode[] = [
      <div key="role" className="message-role">
        {msg.role === "toolResult" ? "tool result" : msg.role}
      </div>,
    ];

    // Render parts
    const parts = renderMessageParts(
      msg.content ?? [],
      results,
      `message-${messageIndex}`,
      query,
    );
    parts.forEach((p) => boxChildren.push(p));

    if (msg.errorMessage) {
      boxChildren.push(
        <div key="error" className="error-text">
          {msg.errorMessage}
        </div>,
      );
    }

    // Search filter
    const textContent = extractText(msg);
    const passesFilter =
      !lowerQuery || textContent.toLowerCase().includes(lowerQuery);

    if (passesFilter) {
      elements.push(
        <article
          key={messageIndex}
          className={`message ${roleClass}${errorClass}`}
        >
          {boxChildren}
        </article>,
      );
    }

    messageIndex++;
  }

  if (elements.length === 0) {
    return (
      <div className="empty-state">
        {query ? "No transcript matches" : "No messages captured"}
      </div>
    );
  }

  return elements;
}

function renderMessageParts(
  parts: AgentTranscript["messages"][number]["content"],
  results: Map<string, AgentTranscript["messages"][number]>,
  keyPrefix: string,
  query: string,
): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let partIndex = 0;

  for (const part of parts) {
    switch (part.type) {
      case "text": {
        const text = part.text + (part.truncated ? "\n[content truncated]" : "");
        nodes.push(
          <div key={partIndex} className="message-content">
            <HighlightedText text={text} query={query} />
          </div>,
        );
        break;
      }
      case "thinking": {
        const thoughtText = part.text + (part.truncated ? "\n[content truncated]" : "");
        nodes.push(
          <details
            key={partIndex}
            className="thinking"
            data-detail-key={`${keyPrefix}-thinking-${partIndex}`}
          >
            <summary>Thinking</summary>
            <div className="message-content">
              <HighlightedText text={thoughtText} query={query} />
            </div>
          </details>,
        );
        break;
      }
      case "toolCall": {
        const result = part.toolCallId ? results.get(part.toolCallId) : undefined;
        nodes.push(
          <details
            key={partIndex}
            className="tool-call"
            data-detail-key={`tool-${part.toolCallId ?? partIndex}`}
          >
            <summary>{part.toolName ?? "tool"}</summary>
            <div className="message-content">
              <HighlightedText text={part.arguments ?? "{}"} query={query} />
            </div>
            {result && (
              <ToolResultContent
                result={result}
                keyPrefix={`${keyPrefix}-result-${partIndex}`}
                query={query}
              />
            )}
          </details>,
        );
        break;
      }
      case "image": {
        nodes.push(
          <div key={partIndex} className="muted">
            [image {part.mimeType ?? ""}]
          </div>,
        );
        break;
      }
    }
    partIndex++;
  }

  return nodes;
}

function ToolResultContent({
  result,
  keyPrefix,
  query,
}: {
  result: AgentTranscript["messages"][number];
  keyPrefix: string;
  query: string;
}) {
  const errorClass = result.isError ? " error" : "";
  const parts = renderMessageParts(result.content ?? [], new Map(), keyPrefix, query);

  return (
    <div className={`message tool-result${errorClass}`}>
      <div className="message-role">
        {result.isError ? "tool error" : "tool result"}
      </div>
      {parts}
    </div>
  );
}

function HighlightedText({ text, query }: { text: string; query: string }) {
  if (!query.trim()) return <>{text}</>;

  const lower = text.toLowerCase();
  const needle = query.toLowerCase().trim();
  const parts: React.ReactNode[] = [];
  let offset = 0;

  let index = lower.indexOf(needle, offset);
  while (index >= 0) {
    if (index > offset) {
      parts.push(text.slice(offset, index));
    }
    parts.push(<mark key={index}>{text.slice(index, index + query.length)}</mark>);
    offset = index + query.length;
    index = lower.indexOf(needle, offset);
  }
  if (offset < text.length) {
    parts.push(text.slice(offset));
  }

  return <>{parts}</>;
}

function extractText(msg: AgentTranscript["messages"][number]): string {
  let result = "";
  for (const part of msg.content ?? []) {
    if (part.type === "text" || part.type === "thinking") {
      result += part.text ?? "";
    } else if (part.type === "toolCall") {
      result += part.arguments ?? "";
    }
  }
  return result;
}
