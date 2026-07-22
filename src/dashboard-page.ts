import { UI_PHASE_LABELS } from "./types.js";

const PHASES_JSON = JSON.stringify(UI_PHASE_LABELS);

export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>piOrchestrator</title>
<style>
:root{--bg:#0d1117;--surface:#161b22;--border:#30363d;--fg:#e6edf3;--muted:#8b949e;--accent:#58a6ff;--green:#3fb950;--amber:#d29922;--red:#f85149;--radius:8px;--gap:16px;--max-w:1280px}
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
}
</style>
</head>
<body>
<a href="#overview" class="skip-link">Skip to current activity</a>
<div class="shell">
<header>
<div class="header-main">
<span class="product-name">piOrchestrator</span>
<span id="status-badge" class="status-badge idle">Idle</span>
<span id="connection-badge" class="connection-badge connecting">Connecting</span>
<span id="elapsed-display" class="elapsed"></span>
<span id="run-id-display" class="run-id muted"></span>
</div>
<div id="request-display" class="request" role="status"></div>
</header>
<nav id="section-nav" aria-label="Dashboard sections" hidden>
<a href="#overview" class="section-link" aria-current="location">Overview</a>
<a href="#agents" class="section-link">Agents</a>
<a href="#timeline" class="section-link">Timeline</a>
<a href="#artifacts" class="section-link">Artifacts</a>
</nav>
<main>
<section id="overview" aria-label="Current overview" tabindex="-1">
<div id="callout" role="status" aria-live="polite"></div>
<div id="phases"></div>
<div class="overview-grid">
<div id="activity" class="panel"><div class="empty-state"><p>Loading activity…</p></div></div>
<div id="run-details" class="panel"><div class="empty-state"><p>Loading details…</p></div></div>
</div>
</section>
<section id="agents" aria-label="Agents" tabindex="-1">
<h2 class="section-heading">Agents</h2>
<div class="agents-layout">
<div id="agent-grid" class="agent-grid" role="group"></div>
<div id="agent-inspector" class="agent-inspector panel" hidden><div class="empty-state"><p>Select an agent to inspect</p></div></div>
</div>
</section>
<section id="timeline" aria-label="Timeline" tabindex="-1">
<h2 class="section-heading">Timeline</h2>
<div id="timeline-entries" role="list"></div>
</section>
<section id="artifacts" aria-label="Artifacts" tabindex="-1">
<h2 class="section-heading">Recent Artifacts</h2>
<div id="artifact-list" class="artifact-list"></div>
<div id="artifact-viewer" class="artifact-viewer panel" hidden></div>
</section>
</main>
</div>
<script>
var PHASES = ${PHASES_JSON};
var app = {
  snapshot: null, mode: null, runId: null,
  connection: 'connecting', selectedAgent: null, agentMode: 'auto',
  selectedArtifact: null, agentReq: 0, artifactReq: 0,
  timer: null, elapsedBase: 0, elapsedAt: 0,
  lastFetchedAgent: null,
  agentEl: null, inspectorEl: null
};
function qs(s){return document.querySelector(s)}
function id(s){return document.getElementById(s)}
function esc(v){return String(v??'').replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function trunc(v,m){return !v||v.length<=m?String(v??''):v.slice(0,m-1)+'…'}
function ago(t){if(!t)return'';var s=t.slice(11,19);return s}
function elapsedText(ms){var s=Math.floor(ms/1000);var m=Math.floor(s/60);s=s%60;if(m>=60){var h=Math.floor(m/60);return h+'h'+String(m%60).padStart(2,'0')+'m'}return m+':'+String(s).padStart(2,'0')}

function statusLabel(s){if(s==='completed'||s==='succeeded')return'✓ Succeeded';if(s==='running')return'→ Running';if(s==='failed')return'! Failed';if(s==='cancelled')return'— Cancelled';if(s==='waiting')return'◷ Waiting';if(s==='config_error')return'✕ Config Error';return'● Idle'}

// ── element helpers ─────────────────────────────────────────
function el(tag,attrs,children){var e=document.createElement(tag);if(attrs)for(var k in attrs)if(k==='className')e.className=attrs[k];else if(k.startsWith('data'))e.setAttribute(k,attrs[k]);else if(k==='htmlFor')e.setAttribute('for',attrs[k]);else e.setAttribute(k,attrs[k]);if(children){if(typeof children==='string')e.textContent=children;else if(Array.isArray(children))children.forEach(function(c){if(c!=null)e.append(typeof c==='string'?document.createTextNode(c):c)})}return e}
function btn(text,attrs,onclick){var b=el('button',Object.assign({type:'button',className:'close-btn'},attrs||{}));b.textContent=text;if(onclick)b.addEventListener('click',onclick);return b}
function artBtn(name){return btn(esc(name),{className:'artifact-btn','data-artifact':esc(name)},function(){openArtifact(name)})}

// ── render functions ────────────────────────────────────────
function render(snapshot){
  var old=app.snapshot;app.snapshot=snapshot;
  if(!snapshot||!snapshot.run){
    var cfg=snapshot&&snapshot.config||{status:'missing',agentCount:0,checkCount:0,message:''};
    renderIdle(cfg,snapshot&&snapshot.cwd||'',snapshot&&snapshot.commands||[]);
    if(app.selectedArtifact)closeArtifact();
    if(app.selectedAgent)closeAgent();
    return
  }
  var run=snapshot.run;app.mode=snapshot.mode;app.runId=run.id;
  // If run id changed, reset transient state
  if(old&&old.run&&old.run.id!==run.id){app.selectedAgent=null;app.agentMode='auto';app.lastFetchedAgent=null;app.selectedArtifact=null;app.agentReq=0;app.artifactReq=0}
  renderHeader(snapshot);
  renderConnection();
  renderPhases(run);
  renderCallout(snapshot);
  renderActivity(snapshot);
  renderRunDetails(snapshot);
  renderAgentGrid(snapshot.agents||[]);
  renderTimeline(snapshot.recentSteps||[]);
  renderArtifactList(snapshot);
  // Auto-follow active agent
  if(!app.selectedAgent&&run.activeAgent){app.selectedAgent=run.activeAgent;app.agentMode='auto';updateAgentSelection(run.activeAgent)}
  else if(app.selectedAgent){updateAgentSelection(app.selectedAgent)}
  startElapsedTimer(run);
  id('section-nav').removeAttribute('hidden');
}
function renderHeader(snapshot){
  var mode=snapshot.mode||'idle';var run=snapshot.run;
  var badge=id('status-badge');
  badge.textContent=mode;
  badge.className='status-badge '+mode;
  id('request-display').textContent=run?run.request||'':'';
  id('run-id-display').textContent=run?run.id.slice(0,8):'';
}
function renderConnection(){
  var el=id('connection-badge');
  var labels={connecting:'Connecting',live:'Live',reconnecting:'Reconnecting',disconnected:'Disconnected'};
  el.textContent=labels[app.connection]||app.connection;
  el.className='connection-badge '+app.connection;
}
function renderPhases(run){
  var pi=run.phaseIndex,pc=run.phaseCount||PHASES.length;
  var container=id('phases');container.innerHTML='';
  PHASES.forEach(function(p,i){
    var cls='phase'+(i<pi?' done':i===pi?' active':' pending');
    var icon=i<pi?'✓':i===pi?'→':'•';
    var phaseEl=el('div',{className:cls,'aria-current':i===pi?'step':undefined,'aria-label':(i<pi?'Completed: ':i===pi?'Current: ':'Pending: ')+p},
      [el('span',{className:'phase-icon','aria-hidden':'true'},icon),' ',p]
    );
    container.appendChild(phaseEl)
  })
}
function renderCallout(snapshot){
  var mode=snapshot.mode;var run=snapshot.run;var c=id('callout');
  c.innerHTML='';c.removeAttribute('class');c.removeAttribute('role');
  if(mode==='waiting'&&run&&run.waitingFor){
    c.className='waiting';c.setAttribute('role','status');c.setAttribute('aria-live','polite');
    c.appendChild(el('div',{className:'callout-title'},'Waiting for input'));
    c.appendChild(el('div',{className:'callout-body'},esc(run.waitingFor)));
    return
  }
  if(mode==='failed'&&run){
    c.className='failed';c.setAttribute('role','alert');
    c.appendChild(el('div',{className:'callout-title'},'Failed'));
    if(run.message)c.appendChild(el('div',{className:'callout-body'},esc(run.message)));
    if(run.failedArtifact){var fab=btn('Open failed artifact',{className:'close-btn',style:'margin-top:6px'},function(){openArtifact(run.failedArtifact)});c.appendChild(fab)}
    return
  }
  if(mode==='cancelled'&&run){
    c.className='failed';c.style.borderColor='var(--muted)';c.setAttribute('role','status');c.setAttribute('aria-live','polite');
    c.appendChild(el('div',{className:'callout-title'},'Cancelled'));
    if(run.message)c.appendChild(el('div',{className:'callout-body'},esc(run.message)));
    return
  }
  if(mode==='completed'&&run){
    c.className='completed';c.setAttribute('role','status');c.setAttribute('aria-live','polite');
    c.appendChild(el('div',{className:'callout-title'},'Completed'));
    if(run.message)c.appendChild(el('div',{className:'callout-body'},esc(run.message)));
    return
  }
  if(mode==='config_error'){
    c.className='failed';c.setAttribute('role','alert');
    c.appendChild(el('div',{className:'callout-title'},'Configuration error'));
    c.appendChild(el('div',{className:'callout-body'},esc(snapshot.config.message||'The configuration file could not be validated')));
    return
  }
  c.hidden=true
}
function renderActivity(snapshot){
  var run=snapshot.run;var mode=snapshot.mode;var container=id('activity');
  if(!run){container.innerHTML='<div class="empty-state"><p>No active workflow</p></div>';return}
  container.innerHTML='';
  var phaseLabel=PHASES[run.phaseIndex]||'Unknown';
  var attemptText=run.attempt>0?' attempt '+run.attempt+'/'+run.maxAttempts:'';
  // Title
  container.appendChild(el('div',{style:'font-weight:600;margin-bottom:8px;font-size:.95em'},'Current activity'));
  // Current phase + stage
  var title=el('div',{className:'value-row'},[el('span',{className:'value'},[esc(phaseLabel),attemptText]),el('span',{className:'muted'},esc(run.stage||''))]);
  container.appendChild(title);
  // Active agent
  if(run.activeAgent){
    var agentLine=el('div',{className:'value-row'});
    agentLine.appendChild(el('span',{className:'label'},'Agent:'));
    var agentBtn=btn(esc(run.activeAgent),{className:'close-btn','data-agent':run.activeAgent},function(){selectAgent(run.activeAgent)});
    agentBtn.style.fontWeight='600';
    agentLine.appendChild(agentBtn);
    container.appendChild(agentLine)
  }
  // Current tool
  if(run.currentTool){
    var toolLine=el('div',{className:'value-row'});
    toolLine.appendChild(el('span',{className:'label'},'Tool:'));
    var dot=el('span',{className:'tool-status-dot '+(run.toolStatus||'ok'),'aria-label':run.toolStatus||'ok'});
    toolLine.appendChild(dot);
    toolLine.appendChild(el('span',{className:'value'},esc(run.currentTool)));
    if(run.currentToolArgs)toolLine.appendChild(el('span',{className:'muted'},esc(trunc(run.currentToolArgs,80))));
    container.appendChild(toolLine)
  }
  // Live output
  if(run.agentOutput&&run.agentOutput.length>0){
    var out=el('div',{className:'output-box','aria-label':'Agent output'});out.style.maxHeight='120px';
    run.agentOutput.forEach(function(l){out.appendChild(document.createTextNode(l))});
    container.appendChild(out)
  }
}
function renderRunDetails(snapshot){
  var run=snapshot.run;var config=snapshot.config;var container=id('run-details');
  if(!run){container.innerHTML='<div class="empty-state"><p>No active workflow</p></div>';return}
  container.innerHTML='';
  container.appendChild(el('div',{style:'font-weight:600;margin-bottom:8px;font-size:.95em'},'Run details'));
  var rows=[
    ['Status',run.runStatus],
    ['Stage',run.stage],
    ['Attempt',run.attempt+'/'+run.maxAttempts],
    ['Checks',config?String(config.checkCount):'—'],
    ['Version',run.extensionVersion||'?'],
    ['Artifacts',run.artifactPath]
  ];
  rows.forEach(function(r){
    var row=el('div',{className:'value-row'});
    row.appendChild(el('span',{className:'label'},r[0]+':'));
    row.appendChild(el('span',{className:'value'},r[1]?esc(r[1]):'—'));
    container.appendChild(row)
  })
}
function renderAgentGrid(agents){
  var container=id('agent-grid');var existing={};
  container.querySelectorAll('.agent-card').forEach(function(c){existing[c.getAttribute('data-agent')]=c});
  agents.forEach(function(a){
    var card=existing[a.name];
    if(card){delete existing[a.name]}else{
      card=el('button',{type:'button',className:'agent-card','data-agent':a.name,'aria-pressed':'false'});
      card.addEventListener('click',function(){selectAgent(a.name)});container.appendChild(card)
    }
    var sc=a.status==='succeeded'?'succeeded':a.status==='running'?'running':a.status==='failed'?'failed':a.status==='cancelled'?'cancelled':'idle';
    card.className='agent-card'+(a.name===app.selectedAgent?' selected':'');
    card.setAttribute('aria-pressed',String(a.name===app.selectedAgent));
    card.innerHTML='<span class="agent-name"><span class="status-dot '+sc+'" aria-hidden="true"></span>'+esc(a.name)+'</span><span class="muted">'+esc(a.model||'')+'</span><br>'+esc(statusLabel(a.status))+(a.summary?'<br><span class="agent-summary">'+esc(trunc(a.summary,80))+'</span>':'')+(a.error?'<br><span class="error-text">'+esc(trunc(a.error,80))+'</span>':'');
  });
  for(var name in existing)existing[name].remove()
}
function updateAgentSelection(name){
  id('agent-grid').querySelectorAll('.agent-card').forEach(function(c){
    var match=c.getAttribute('data-agent')===name;
    c.className='agent-card'+(match?' selected':'');
    c.setAttribute('aria-pressed',String(match))
  });
  if(name&&app.agentMode!=='closed'&&name!==app.lastFetchedAgent){app.lastFetchedAgent=name;fetchAgent(name)}
}
function selectAgent(name){
  if(name===app.selectedAgent&&app.agentMode!=='closed'){closeAgent();return}
  app.selectedAgent=name;app.agentMode='manual';
  updateAgentSelection(name)
}
function fetchAgent(name){
  app.agentReq++;var req=app.agentReq;
  var panel=id('agent-inspector');
  panel.innerHTML='<div class="closable-header" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><h3>'+esc(name)+'</h3>'+'<button class="close-btn" id="close-inspector">Close</button></div><div class="empty-state"><p>Loading…</p></div>';
  panel.removeAttribute('hidden');
  id('close-inspector').addEventListener('click',closeAgent);
  fetch('/api/agents/'+encodeURIComponent(name),{cache:'no-store'}).then(function(r){if(!r.ok)return null;return r.json()}).then(function(data){
    if(req!==app.agentReq||app.selectedAgent!==name)return;
    if(!data){panel.innerHTML='<div class="closable-header" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><h3>'+esc(name)+'</h3><button class="close-btn" id="close-inspector">Close</button></div><div class="empty-state"><p>No data available</p></div>';id('close-inspector')&&id('close-inspector').addEventListener('click',closeAgent);return}
    panel.innerHTML='<div class="closable-header" style="display:flex;justify-content:space-between;align-items:center"><h3>'+esc(data.name)+' <span class="muted">'+esc(data.status)+'</span></h3><button class="close-btn" id="close-inspector">Close</button></div>';
    id('close-inspector').addEventListener('click',closeAgent);
    if(data.model)panel.appendChild(el('div',{className:'meta'},'Model: '+esc(data.model)));
    if(data.startedAt)panel.appendChild(el('div',{className:'meta'},'Started: '+esc(data.startedAt.slice(0,19).replace('T',' '))));
    if(data.completedAt)panel.appendChild(el('div',{className:'meta'},'Completed: '+esc(data.completedAt.slice(0,19).replace('T',' '))));
    if(data.summary){var sm=el('p',{className:'meta'});sm.textContent=trunc(data.summary,200);panel.appendChild(sm)}
    if(data.error)panel.appendChild(el('p',{className:'error-text'},esc(data.error)));
    if(data.currentTool){
      var tc=data.toolStatus||'ok';var tool=el('div',{className:'tool-row'});
      tool.innerHTML='<span class="tool-status-dot '+tc+'"></span> <b>Tool:</b> '+esc(data.currentTool)+(data.currentToolArgs?' <span class="muted">'+esc(trunc(data.currentToolArgs,120))+'</span>':'');
      panel.appendChild(tool)
    }
    if(data.agentOutput&&data.agentOutput.length>0){
      var out=el('div',{className:'output-box'});
      data.agentOutput.forEach(function(l){out.appendChild(document.createTextNode(l))});
      panel.appendChild(out)
    }
    if(data.steps&&data.steps.length>0){
      var sum=el('details');var sumTitle=el('summary');sumTitle.textContent='Steps ('+data.steps.length+')';sum.appendChild(sumTitle);
      var ul=el('ul',{className:'step-list'});
      data.steps.forEach(function(s){
        var li=el('li');
        li.innerHTML='<span class="ts">'+(s.startedAt?esc(s.startedAt.slice(11,19)):'')+'</span> <b>'+esc(s.label)+'</b>'+(s.message?'<br><span class="muted">'+esc(s.message)+'</span>':'');
        if(s.artifact){var ab=artBtn(s.artifact);li.appendChild(ab)}
        if(s.rawArtifact){var rb=artBtn(s.rawArtifact);li.appendChild(rb)}
        ul.appendChild(li)
      });
      sum.appendChild(ul);panel.appendChild(sum)
    }
  }).catch(function(){if(req===app.agentReq)panel.innerHTML='<div class="closable-header" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><h3>'+esc(name)+'</h3><button class="close-btn" id="close-inspector">Close</button></div><p class="error-text">Failed to load agent details</p>';if(id('close-inspector'))id('close-inspector').addEventListener('click',closeAgent)})
}
function closeAgent(){
  app.selectedAgent=null;app.agentMode='closed';app.lastFetchedAgent=null;
  var panel=id('agent-inspector');panel.hidden=true;
  id('agent-grid').querySelectorAll('.agent-card').forEach(function(c){c.className='agent-card';c.setAttribute('aria-pressed','false')});
  var agentsEl=id('agents');if(agentsEl&&document.activeElement&&agentsEl.contains(document.activeElement)){} // don't force focus
}
function renderTimeline(steps){
  var container=id('timeline-entries');
  var reverse=steps.slice().reverse();
  var map={};container.querySelectorAll('.timeline-step').forEach(function(e){var id=e.getAttribute('data-step-id');if(id)map[id]=e;container.removeChild(e)});
  reverse.forEach(function(s,i){
    var existing=map[s.id];
    if(existing){container.appendChild(existing);delete map[s.id];return}
    var entry=el('div',{className:'timeline-step',role:'listitem','data-step-id':s.id});
    entry.appendChild(el('span',{className:'ts'},ago(s.startedAt)));
    var st=s.status==='succeeded'?'succeeded':s.status==='running'?'running':s.status==='failed'?'failed':'cancelled';
    entry.appendChild(el('span',{className:'status-text '+st},s.status==='succeeded'?'✓':s.status==='running'?'→':s.status==='failed'?'!':'—'));
    var main=el('div',{className:'step-main'});
    main.appendChild(el('div',{className:'step-label'},esc(s.label)));
    var meta=el('div',{className:'step-meta'});
    if(s.agent)meta.appendChild(document.createTextNode(esc(s.agent)+' '));
    if(s.attempt)meta.appendChild(document.createTextNode('attempt '+s.attempt+' '));
    if(s.revision)meta.appendChild(document.createTextNode('rev '+s.revision+' '));
    if(s.message)meta.appendChild(document.createTextNode(esc(s.message)));
    main.appendChild(meta);
    if(s.artifact||s.rawArtifact){
      var actions=el('div',{className:'step-actions'});
      if(s.artifact){var ab=artBtn(s.artifact);actions.appendChild(ab)}
      if(s.rawArtifact){var rb=artBtn(s.rawArtifact);actions.appendChild(rb)}
      main.appendChild(actions)
    }
    entry.appendChild(main);
    container.appendChild(entry)
  })
}
function renderArtifactList(snapshot){
  var run=snapshot.run;var steps=snapshot.recentSteps||[];
  var names={};var list=[];
  steps.forEach(function(s){
    if(s.artifact&&!names[s.artifact]){names[s.artifact]=true;list.push(s.artifact)}
    if(s.rawArtifact&&!names[s.rawArtifact]){names[s.rawArtifact]=true;list.push(s.rawArtifact)}
  });
  if(run&&run.failedArtifact&&!names[run.failedArtifact]){names[run.failedArtifact]=true;list.push(run.failedArtifact)}
  var container=id('artifact-list');
  if(list.length===0){container.innerHTML='<span class="muted" style="font-size:.85em">No artifacts yet</span>';return}
  container.innerHTML='';
  list.forEach(function(n){container.appendChild(artBtn(n))})
}

// ── artifact viewer ─────────────────────────────────────────
function openArtifact(name){
  app.selectedArtifact=name;app.artifactReq++;
  var panel=id('artifact-viewer');panel.hidden=false;
  panel.innerHTML='<div class="viewer-header"><h3>'+esc(name)+'</h3><div><button class="wrap-toggle" id="wrap-toggle">Wrap</button><button class="close-btn" id="close-artifact-viewer" style="margin-left:6px">Close</button></div></div><div class="viewer-meta" id="artifact-meta"></div><pre id="artifact-content">Loading…</pre>';
  id('close-artifact-viewer').addEventListener('click',closeArtifact);
  id('wrap-toggle').addEventListener('click',function(){
    var pre=id('artifact-content');var tog=id('wrap-toggle');
    if(pre.style.whiteSpace==='pre'){pre.style.whiteSpace='pre-wrap';tog.textContent='Wrap'}else{pre.style.whiteSpace='pre';tog.textContent='No wrap'}
  });
  var req=app.artifactReq;
  fetch('/api/artifacts/'+encodeURIComponent(name),{cache:'no-store'}).then(function(r){
    var size=r.headers.get('X-Artifact-Size');var truncated=r.headers.get('X-Artifact-Truncated');
    if(req!==app.artifactReq)return null;
    var metaEl=id('artifact-meta');
    if(size)metaEl.textContent='Size: '+size+' bytes'+(truncated==='true'?' (truncated)':'');
    if(!r.ok)throw new Error('HTTP '+r.status);
    return r.text()
  }).then(function(text){
    if(req!==app.artifactReq)return;
    var el=id('artifact-content');
    if(el&&text!=null)el.textContent=text
  }).catch(function(){
    if(req===app.artifactReq){var el=id('artifact-content');if(el)el.textContent='(error loading artifact)'}
  })
}
function closeArtifact(){
  app.selectedArtifact=null;
  var panel=id('artifact-viewer');panel.hidden=true;panel.innerHTML=''
}

// ── elapsed timer ────────────────────────────────────────────
function startElapsedTimer(run){
  if(app.timer){clearInterval(app.timer);app.timer=null}
  if(!run||run.runStatus!=='running'){id('elapsed-display').textContent='';return}
  app.elapsedBase=run.elapsedMs;app.elapsedAt=Date.now();
  id('elapsed-display').textContent=elapsedText(run.elapsedMs);
  app.timer=setInterval(function(){
    if(app.mode==='running'||app.mode==='waiting'){
      id('elapsed-display').textContent=elapsedText(app.elapsedBase+(Date.now()-app.elapsedAt))
    }else{clearInterval(app.timer);app.timer=null}
  },1000)
}

// ── idle state ───────────────────────────────────────────────
function renderIdle(config,cwd,commands){
  id('section-nav').setAttribute('hidden','');
  id('run-id-display').textContent='';
  id('request-display').textContent='';
  id('elapsed-display').textContent='';
  var badge=id('status-badge');
  if(config.status==='invalid'){badge.textContent='CONFIG ERROR';badge.className='status-badge config_error'}else{badge.textContent='IDLE';badge.className='status-badge idle'}
  // callout
  var callout=id('callout');callout.innerHTML='';callout.removeAttribute('class');callout.setAttribute('role','status');callout.setAttribute('aria-live','polite');
  if(config.status==='invalid'){
    callout.className='failed';
    callout.appendChild(el('div',{className:'callout-title'},'Configuration error'));
    callout.appendChild(el('div',{className:'callout-body'},esc(config.message||'The configuration file could not be validated')));
  }else if(config.status==='missing'){
    callout.className='waiting';
    callout.appendChild(el('div',{className:'callout-title'},'Setup required'));
    callout.appendChild(el('div',{className:'callout-body'},'Project checks are not configured. Run <code>/orchestrate &lt;request&gt;</code> to begin setup.'));
  }else{
    callout.className='completed';
    callout.appendChild(el('div',{className:'callout-title'},'Ready'));
    callout.appendChild(el('div',{className:'callout-body'},'Agents: '+config.agentCount+' · Checks: '+config.checkCount+(cwd?' · '+esc(cwd):'')));
  }
  // phases empty
  id('phases').innerHTML='';
  // Activity + details
  id('activity').innerHTML='<div class="empty-state"><p>Run <code>/orchestrate</code> to start a workflow</p>'+(commands.length>0?'<p class="muted">'+commands.map(function(c){return'<code>'+esc(c)+'</code>'}).join(' · ')+'</p>':'')+'</div>';
  id('run-details').innerHTML='<div class="empty-state"><p class="muted">No active workflow</p></div>';
  // Clear agents,timeline,artifacts
  id('agent-grid').innerHTML='';
  id('timeline-entries').innerHTML='';
  id('artifact-list').innerHTML='';
  id('agent-inspector').hidden=true;
  id('artifact-viewer').hidden=true
}

// ── connection ───────────────────────────────────────────────
function setConnection(s){app.connection=s;renderConnection()}

// ── init ─────────────────────────────────────────────────────
// Section nav IntersectionObserver
try{
  var sections=document.querySelectorAll('section[id]');
  var observer=new IntersectionObserver(function(entries){
    entries.forEach(function(entry){
      var link=document.querySelector('.section-link[href="#'+entry.target.id+'"]');
      if(link){
        if(entry.isIntersecting){link.setAttribute('aria-current','location')}
        else{link.removeAttribute('aria-current')}
      }
    })
  },{rootMargin:'-60px 0px -60% 0px'});
  sections.forEach(function(s){observer.observe(s)})
}catch(e){}

// Load initial state, then start SSE
fetch('/api/state',{cache:'no-store'}).then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.json()}).then(function(data){
  if(data){render(data)}
}).catch(function(){});

var es=new EventSource('/events');
es.onopen=function(){setConnection('live')};
es.onmessage=function(e){try{var data=JSON.parse(e.data);if(data)render(data)}catch(ex){}};
es.onerror=function(){setConnection('reconnecting')};
setTimeout(function(){if(app.connection==='reconnecting')setConnection('disconnected')},30000);
</script>
</body>
</html>`;
