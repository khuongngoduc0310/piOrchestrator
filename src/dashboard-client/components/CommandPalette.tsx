import React, { useEffect, useRef, useState } from "react";

export interface PaletteCommand { id: string; label: string; group: string; run: () => void }

export function CommandPalette({ open, commands, onClose }: { open: boolean; commands: PaletteCommand[]; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const paletteRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (open) {
      previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setQuery("");
      setActiveIndex(0);
      setTimeout(() => inputRef.current?.focus(), 0);
      return () => previousFocusRef.current?.focus();
    }
  }, [open]);
  if (!open) return null;
  const visible = commands.filter(command => `${command.group} ${command.label}`.toLowerCase().includes(query.toLowerCase()));
  function execute(command: PaletteCommand | undefined) {
    if (!command) return;
    command.run();
    onClose();
  }
  return <div className="palette-scrim" role="presentation" onMouseDown={event => event.target === event.currentTarget && onClose()}>
    <div ref={paletteRef} className="command-palette" role="dialog" aria-modal="true" aria-labelledby="palette-heading" onKeyDown={event => {
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowDown") { event.preventDefault(); setActiveIndex(index => Math.min(index + 1, Math.max(visible.length - 1, 0))); }
      if (event.key === "ArrowUp") { event.preventDefault(); setActiveIndex(index => Math.max(index - 1, 0)); }
      if (event.key === "Enter") { event.preventDefault(); execute(visible[activeIndex]); }
      if (event.key === "Tab") {
        const focusable = [...(paletteRef.current?.querySelectorAll<HTMLElement>("input, button:not([disabled])") ?? [])];
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    }}>
      <h2 id="palette-heading" className="visually-hidden">Command palette</h2>
      <input ref={inputRef} type="search" value={query} onChange={event => { setQuery(event.target.value); setActiveIndex(0); }} placeholder="Jump to a run, agent, panel, or action" aria-label="Search commands" aria-controls="command-results" aria-activedescendant={visible[activeIndex] ? `command-${visible[activeIndex].id}` : undefined} />
      <div id="command-results" role="listbox" aria-label="Commands">{visible.map((command, index) => <button id={`command-${command.id}`} key={command.id} type="button" role="option" aria-selected={index === activeIndex} className={index === activeIndex ? "active" : undefined} onFocus={() => setActiveIndex(index)} onMouseEnter={() => setActiveIndex(index)} onKeyDown={event => { if (event.key === "Enter") event.stopPropagation(); }} onClick={() => execute(command)}><span>{command.label}</span><small>{command.group}</small></button>)}{visible.length === 0 && <p className="empty-state">No matching command.</p>}</div>
    </div>
  </div>;
}
