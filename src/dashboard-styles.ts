export const DASHBOARD_STYLES = `:root{--bg:#0d1117;--surface:#161b22;--border:#30363d;--fg:#e6edf3;--muted:#8b949e;--accent:#58a6ff;--green:#3fb950;--amber:#d29922;--red:#f85149;--radius:8px;--gap:16px;--max-w:1280px}
*,*::before,*::after{box-sizing:border-box}
body{margin:0;font-family:system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--fg);line-height:1.5;font-size:14px}
.shell{width:min(100% - 24px,var(--max-w));margin:0 auto;padding:12px 0 48px}
a{color:var(--accent)}a:hover{color:var(--green)}
.skip-link{position:absolute;top:-100px;left:8px;background:var(--accent);color:#fff;padding:8px 16px;border-radius:4px;z-index:100}
.skip-link:focus{top:8px}
.panel{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:var(--gap)}
.panel-sm{padding:12px;font-size:.9em}
h1,h2,h3{font-weight:600;margin:0}
h1{font-size:1.1rem}h2{font-size:1rem}h3{font-size:.95rem}
.muted{color:var(--muted);font-size:.85em}
code{font-family:ui-monospace,monospace;font-size:.85em;color:var(--accent);word-break:break-all}
.nowrap{white-space:nowrap}
/* Header */
header{margin-bottom:12px}
.header-main{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.product-name{font-weight:700;font-size:1.1rem;color:var(--accent)}
.status-badge,.connection-badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:.8em;font-weight:600;text-transform:uppercase;letter-spacing:.02em}
.status-badge.idle,.status-badge.completed,.status-badge.succeeded{background:#0a2e1a;color:var(--green)}
.status-badge.running{background:#0c2d4a;color:var(--accent)}
.status-badge.waiting{background:#2e1f0a;color:var(--amber)}
.status-badge.failed{background:#3a0f14;color:var(--red)}
.status-badge.cancelled{background:#222;color:var(--muted)}
.status-badge.config_error{background:#3a0f14;color:var(--red)}
.connection-badge.connecting{background:#222;color:var(--muted);animation:pulse 1.5s infinite}
.connection-badge.live{background:#0a2e1a;color:var(--green)}
.connection-badge.reconnecting{background:#2e1f0a;color:var(--amber)}
.connection-badge.disconnected{background:#3a0f14;color:var(--red)}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
.elapsed{font-variant-numeric:tabular-nums;color:var(--muted);font-size:.85em}
.run-id{font-size:.85em}
.request{margin-top:4px;font-size:.95em;word-wrap:break-word}
/* Navigation */
#section-nav{display:flex;gap:4px;margin-bottom:12px;overflow-x:auto;scrollbar-width:thin;position:sticky;top:0;z-index:10;background:var(--bg);padding:4px 0}
.section-link{display:inline-block;padding:6px 14px;border-radius:var(--radius);font-size:.9em;font-weight:500;color:var(--muted);text-decoration:none;white-space:nowrap;border:1px solid transparent}
.section-link:hover,.section-link:focus-visible{color:var(--fg);background:var(--surface);border-color:var(--border)}
.section-link[aria-current=location]{color:var(--accent);background:var(--surface);border-color:var(--accent)}
/* Callout */
#callout{padding:var(--gap);border-radius:var(--radius);margin-bottom:var(--gap);border:1px solid var(--border);background:var(--surface)}
#callout .callout-title{font-weight:600;font-size:1rem;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
#callout .callout-body{margin-top:4px;color:var(--muted);font-size:.9em}
#callout.waiting{border-color:var(--amber);background:#1a1408}
#callout.waiting .callout-title{color:var(--amber)}
#callout.failed{border-color:var(--red);background:#1f0c10}
#callout.failed .callout-title{color:var(--red)}
#callout.completed{border-color:var(--green);background:#0a1f12}
#callout.completed .callout-title{color:var(--green)}
/* Phases */
#phases{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:var(--gap)}
.phase{display:flex;align-items:center;gap:4px;padding:4px 10px;border-radius:6px;font-size:.82em;background:var(--surface);border:1px solid var(--border);color:var(--muted)}
.phase.done{background:#0a2e1a;color:var(--green);border-color:transparent}
.phase.active{background:#0c2d4a;color:var(--accent);border-color:var(--accent);font-weight:600}
.phase .phase-icon{flex-shrink:0;width:14px;text-align:center}
/* Overview grid */
.overview-grid{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,1fr);gap:var(--gap);margin-bottom:var(--gap)}
.overview-grid .panel{min-width:0}
#activity .label{color:var(--muted);font-size:.85em;display:block;margin-bottom:2px}
#activity .value{font-family:ui-monospace,monospace;font-size:.9em;word-wrap:break-word}
#activity .value-row{display:flex;gap:8px;flex-wrap:wrap;margin:4px 0}
#activity .tool-status-dot{display:inline-block;width:8px;height:8px;border-radius:50%;flex-shrink:0}
#activity .tool-status-dot.ok{background:var(--green)}
#activity .tool-status-dot.error{background:var(--red)}
#activity .tool-status-dot.retrying{background:var(--amber)}
/* Agent grid */
.agents-layout{display:grid;grid-template-columns:minmax(0,1fr);gap:var(--gap)}
.agent-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,160px),1fr));gap:8px}
.agent-card{border:2px solid var(--border);border-radius:var(--radius);padding:10px;font-size:.85em;cursor:pointer;background:var(--surface);color:var(--fg);text-align:left;width:100%;transition:border-color .15s}
.agent-card:hover,.agent-card:focus-visible{border-color:var(--muted);outline:none}
.agent-card.selected{border-color:var(--accent)}
.agent-card .agent-name{font-weight:600;display:flex;align-items:center;gap:4px}
.agent-card .status-dot{display:inline-block;width:8px;height:8px;border-radius:50%;flex-shrink:0}
.agent-card .status-dot.succeeded{background:var(--green)}
.agent-card .status-dot.running{background:var(--accent)}
.agent-card .status-dot.failed{background:var(--red)}
.agent-card .status-dot.idle,.agent-card .status-dot.cancelled{background:var(--muted)}
.agent-card .agent-summary{color:var(--muted);overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
/* Agent inspector */
.agent-inspector.panel{padding:var(--gap)}
.agent-inspector h3{margin:0 0 8px;display:flex;align-items:center;gap:8px}
.agent-inspector .meta{color:var(--muted);font-size:.85em;margin:4px 0}
.agent-inspector .tool-row{background:var(--bg);padding:8px;border-radius:6px;margin:8px 0;font-family:ui-monospace,monospace;font-size:.85em}
.agent-inspector .output-box{background:var(--bg);padding:8px;border-radius:6px;font-family:ui-monospace,monospace;font-size:.82em;white-space:pre-wrap;word-break:break-all;max-height:200px;overflow-y:auto;margin:8px 0;line-height:1.4}
.agent-inspector .step-list{list-style:none;padding:0;margin:8px 0}
.agent-inspector .step-list li{padding:6px 0;border-bottom:1px solid var(--border);font-size:.85em}
.agent-inspector .step-list li:last-child{border-bottom:0}
.agent-inspector .step-list .ts{color:var(--muted);font-size:.8em}
.invocation-list{display:flex;gap:6px;flex-wrap:wrap;margin:12px 0}
.invocation-btn{background:var(--bg);border:1px solid var(--border);color:var(--muted);padding:5px 9px;border-radius:5px;cursor:pointer;font-size:.8em}
.invocation-btn.selected,.invocation-btn:hover,.invocation-btn:focus-visible{border-color:var(--accent);color:var(--accent);outline:none}
.transcript{display:flex;flex-direction:column;gap:10px;margin-top:10px;max-height:68vh;overflow-y:auto;padding-right:3px}
.message{border:1px solid var(--border);border-radius:7px;padding:10px;background:var(--bg);min-width:0}
.message.user{border-left:3px solid var(--accent)}
.message.assistant{border-left:3px solid var(--green)}
.message.tool-result{border-left:3px solid var(--amber);margin-top:6px}
.message.error{border-left-color:var(--red)}
.message-role{font-size:.72em;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);font-weight:700;margin-bottom:6px}
.message-content{white-space:pre-wrap;overflow-wrap:anywhere;font-family:ui-monospace,monospace;font-size:.82em;line-height:1.45}
.thinking,.tool-call{border:1px solid var(--border);border-radius:5px;margin-top:7px;background:var(--surface)}
.thinking summary,.tool-call summary{cursor:pointer;padding:6px 8px;color:var(--muted);font-size:.8em;font-weight:600}
.thinking .message-content,.tool-call .message-content{padding:0 8px 8px}
.transcript-note{font-size:.78em;color:var(--amber);margin:6px 0}
/* Timeline */
#timeline-entries{display:flex;flex-direction:column;gap:4px;margin-top:8px}
.timeline-step{display:grid;grid-template-columns:5em 2.5em 1fr;gap:6px;padding:6px 8px;border-radius:6px;font-size:.85em;align-items:start;background:var(--surface);border:1px solid var(--border)}
.timeline-step .ts{color:var(--muted);font-size:.8em;white-space:nowrap;font-family:ui-monospace,monospace}
.timeline-step .status-text{font-size:.8em;font-weight:600;text-transform:uppercase}
.timeline-step .status-text.succeeded{color:var(--green)}
.timeline-step .status-text.running{color:var(--accent)}
.timeline-step .status-text.failed{color:var(--red)}
.timeline-step .status-text.cancelled{color:var(--muted)}
.timeline-step .step-main{min-width:0}
.timeline-step .step-label{font-weight:500}
.timeline-step .step-meta{color:var(--muted);font-size:.85em;margin-top:2px}
.timeline-step .step-actions{margin-top:4px;display:flex;gap:6px;flex-wrap:wrap}
/* Artifacts */
.artifact-list{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.artifact-btn{background:var(--surface);border:1px solid var(--border);color:var(--accent);padding:4px 10px;border-radius:4px;font-size:.85em;cursor:pointer;font-family:ui-monospace,monospace}
.artifact-btn:hover,.artifact-btn:focus-visible{background:var(--border);outline:none}
.artifact-viewer{margin-top:var(--gap)}
.artifact-viewer .viewer-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;gap:8px}
.artifact-viewer .viewer-header h3{margin:0}
.artifact-viewer .viewer-meta{color:var(--muted);font-size:.8em}
.artifact-viewer pre{background:var(--bg);padding:12px;border-radius:6px;font-family:ui-monospace,monospace;font-size:.82em;white-space:pre-wrap;word-break:break-all;max-height:70vh;overflow-y:auto;line-height:1.4;margin:0}
.artifact-viewer .wrap-toggle{background:transparent;border:1px solid var(--border);color:var(--muted);padding:2px 8px;border-radius:4px;cursor:pointer;font-size:.8em}
/* Artifact viewer close button */
.close-btn{background:var(--border);border:0;color:var(--fg);padding:4px 12px;border-radius:4px;cursor:pointer;font-size:.85em}
.close-btn:hover{background:var(--muted)}
/* Empty state */
.empty-state{text-align:center;padding:32px 16px;color:var(--muted)}
.empty-state p{margin:4px 0}
/* Section headings */
.section-heading{font-size:1rem;font-weight:600;margin:0 0 8px;color:var(--fg)}
/* Error styling */
.error-text{color:var(--red)}
/* Hover detail for agent cards in desktop expanded view */
@media(min-width:768px){
.agents-layout.show-inspector{grid-template-columns:minmax(0,1fr) minmax(280px,380px)}
.agent-inspector{min-width:0}
}
@media(max-width:600px){
.shell{width:min(100% - 8px,var(--max-w))}
.overview-grid{grid-template-columns:1fr}
.agent-grid{grid-template-columns:1fr}
.timeline-step{grid-template-columns:1fr;gap:2px}
.timeline-step .ts{grid-column:1}
.phase{font-size:.78em;padding:3px 6px}
.body{padding:0}
#section-nav{overflow-x:auto;-webkit-overflow-scrolling:touch}
}
@media(prefers-reduced-motion:reduce){
.agent-card{transition:none}.connection-badge.connecting{animation:none}
}`;
