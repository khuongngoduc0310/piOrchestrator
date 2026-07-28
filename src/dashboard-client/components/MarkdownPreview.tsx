import React, { type ReactNode } from "react";

interface MarkdownPreviewProps {
  markdown: string;
  className?: string;
}

export function MarkdownPreview({ markdown, className }: MarkdownPreviewProps) {
  const lines = markdown.split("\n");
  const elements: ReactNode[] = [];
  let inList: "ul" | "ol" | null = null;
  let listItems: ReactNode[] = [];

  function flushList(keyPrefix: string) {
    if (inList === "ul" && listItems.length > 0) {
      elements.push(<ul key={`${keyPrefix}-ul`}>{listItems}</ul>);
    } else if (inList === "ol" && listItems.length > 0) {
      elements.push(<ol key={`${keyPrefix}-ol`}>{listItems}</ol>);
    }
    listItems = [];
    inList = null;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === "") {
      flushList(`p-${i}`);
      continue;
    }

    // Headings
    const h3Match = trimmed.match(/^###\s+(.*)/);
    if (h3Match) {
      flushList(`h3-${i}`);
      elements.push(<h3 key={`h3-${i}`}>{renderInline(h3Match[1])}</h3>);
      continue;
    }
    const h2Match = trimmed.match(/^##\s+(.*)/);
    if (h2Match) {
      flushList(`h2-${i}`);
      elements.push(<h2 key={`h2-${i}`}>{renderInline(h2Match[1])}</h2>);
      continue;
    }
    const h1Match = trimmed.match(/^#\s+(.*)/);
    if (h1Match) {
      flushList(`h1-${i}`);
      elements.push(<h1 key={`h1-${i}`}>{renderInline(h1Match[1])}</h1>);
      continue;
    }

    // Checkboxes BEFORE generic unordered list
    const checkboxMatch = trimmed.match(/^-\s+\[([ x])\]\s+(.*)/);
    if (checkboxMatch) {
      if (inList !== "ul") flushList(`l-${i}`);
      inList = "ul";
      const checked = checkboxMatch[1] === "x";
      listItems.push(
        <li key={`li-${i}`}>
          <input type="checkbox" checked={checked} readOnly />{" "}
          {renderInline(checkboxMatch[2])}
        </li>,
      );
      continue;
    }

    // Unordered list
    const ulMatch = trimmed.match(/^[-*]\s+(.*)/);
    if (ulMatch) {
      if (inList !== "ul") flushList(`l-${i}`);
      inList = "ul";
      listItems.push(<li key={`li-${i}`}>{renderInline(ulMatch[1])}</li>);
      continue;
    }

    // Ordered list
    const olMatch = trimmed.match(/^\d+[.)]\s+(.*)/);
    if (olMatch) {
      if (inList !== "ol") flushList(`l-${i}`);
      inList = "ol";
      listItems.push(<li key={`li-${i}`}>{renderInline(olMatch[1])}</li>);
      continue;
    }

    // Horizontal rule
    if (/^-{3,}$/.test(trimmed)) {
      flushList(`hr-${i}`);
      elements.push(<hr key={`hr-${i}`} />);
      continue;
    }

    flushList(`p-${i}`);
    elements.push(<p key={`p-${i}`}>{renderInline(line)}</p>);
  }

  flushList("end");

  return <div className={className}>{elements}</div>;
}

function renderInline(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let remaining = text;
  let key = 0;

  while (remaining.length > 0) {
    // Bold **text**
    const boldMatch = remaining.match(/^\*\*(.+?)\*\*/);
    if (boldMatch) {
      parts.push(<strong key={key++}>{boldMatch[1]}</strong>);
      remaining = remaining.slice(boldMatch[0].length);
      continue;
    }

    // Inline code `text`
    const codeMatch = remaining.match(/^`(.+?)`/);
    if (codeMatch) {
      parts.push(<code key={key++}>{codeMatch[1]}</code>);
      remaining = remaining.slice(codeMatch[0].length);
      continue;
    }

    // Markdown link [text](url)
    const linkMatch = remaining.match(/^\[(.+?)\]\((.+?)\)/);
    if (linkMatch) {
      const href = safeLinkHref(linkMatch[2]);
      parts.push(href === null
        ? linkMatch[1]
        : <a key={key++} href={href} target="_blank" rel="noreferrer">
            {linkMatch[1]}
          </a>);
      remaining = remaining.slice(linkMatch[0].length);
      continue;
    }

    // Newline
    if (remaining[0] === "\n") {
      parts.push(<br key={key++} />);
      remaining = remaining.slice(1);
      continue;
    }

    // Find next special character
    const nextSpecial = remaining.search(/[\n*`[\]]/);
    if (nextSpecial === 0) {
      // Unmatched special char — emit literally
      parts.push(remaining[0]);
      remaining = remaining.slice(1);
      continue;
    }
    if (nextSpecial > 0) {
      parts.push(remaining.slice(0, nextSpecial));
      remaining = remaining.slice(nextSpecial);
    } else {
      parts.push(remaining);
      remaining = "";
    }
  }

  return parts;
}

function safeLinkHref(value: string): string | null {
  const href = value.trim();
  try {
    const protocol = new URL(href, "https://dashboard.invalid").protocol;
    return protocol === "http:" || protocol === "https:" || protocol === "mailto:"
      ? href
      : null;
  } catch {
    return null;
  }
}
