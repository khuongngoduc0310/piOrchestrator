export const DASHBOARD_CLIENT_CORE = `
var app = {
  snapshot: null, liveSnapshot: null, mode: null, runId: null, selectedRunId: null,
  connection: 'connecting', selectedAgent: null, agentMode: 'auto',
  selectedArtifact: null, agentReq: 0, artifactReq: 0,
  transcriptReq: 0, selectedInvocation: null,
  diffReq: 0, inspectorTab: 'transcript', transcriptQuery: '', currentTranscript: null, invocations: [], selectedDiffFile: 0,
  lastTranscriptRevision: -1,
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
function artBtn(name){return btn(name,{className:'artifact-btn','data-artifact':name},function(){openArtifact(name)})}

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
  if(old&&old.run&&old.run.id!==run.id){app.selectedAgent=null;app.agentMode='auto';app.lastFetchedAgent=null;app.lastTranscriptRevision=-1;app.selectedArtifact=null;app.selectedInvocation=null;app.currentTranscript=null;app.invocations=[];app.agentReq=0;app.artifactReq=0;app.transcriptReq=0;app.diffReq++;closeArtifact()}
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
  if(app.agentMode==='auto'&&run.activeAgent&&app.selectedAgent!==run.activeAgent){app.selectedAgent=run.activeAgent;app.selectedInvocation=null;app.lastFetchedAgent=null;updateAgentSelection(run.activeAgent)}
  else if(app.selectedAgent){updateAgentSelection(app.selectedAgent)}
  startElapsedTimer(run);
  id('section-nav').removeAttribute('hidden');
}
function renderHeader(snapshot){
  var mode=snapshot.mode||'idle';var run=snapshot.run;
  var badge=id('status-badge');
  badge.textContent=mode;
  badge.className='status-badge '+mode;
  id('request-display').textContent=run?(run.route?'['+run.route+'] ':'')+(run.request||''):'';
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
  var skipped=run.skippedPhaseIndexes||[];
  var container=id('phases');container.innerHTML='';
  PHASES.forEach(function(p,i){
    var isSkipped=skipped.indexOf(i)>=0;
    var cls='phase'+(isSkipped?' skipped':i<pi?' done':i===pi?' active':' pending');
    var icon=isSkipped?'–':i<pi?'✓':i===pi?'→':'•';
    var phaseEl=el('div',{className:cls,'aria-current':i===pi?'step':undefined,'aria-label':(isSkipped?'Skipped: ':i<pi?'Completed: ':i===pi?'Current: ':'Pending: ')+p},
      [el('span',{className:'phase-icon','aria-hidden':'true'},icon),' ',p]
    );
    container.appendChild(phaseEl)
  })
}
function renderCallout(snapshot){
  var mode=snapshot.mode;var run=snapshot.run;var c=id('callout');
  c.innerHTML='';c.hidden=false;c.removeAttribute('class');c.removeAttribute('role');
  if(mode==='waiting'&&run&&run.waitingFor){
    c.className='waiting';c.setAttribute('role','status');c.setAttribute('aria-live','polite');
    c.appendChild(el('div',{className:'callout-title'},'Waiting for input'));
    c.appendChild(el('div',{className:'callout-body'},run.waitingFor));
    return
  }
  if(mode==='failed'&&run){
    c.className='failed';c.setAttribute('role','alert');
    c.appendChild(el('div',{className:'callout-title'},'Failed'));
    if(run.message)c.appendChild(el('div',{className:'callout-body'},run.message));
    if(run.failedArtifact){var fab=btn('Open failed artifact',{className:'close-btn',style:'margin-top:6px'},function(){openArtifact(run.failedArtifact)});c.appendChild(fab)}
    if(run.resumeCommand)c.appendChild(el('div',{className:'callout-body'},'Safe checkpoint: '+esc(run.checkpoint&&run.checkpoint.cursor||'available')+' · '+esc(run.resumeCommand)));
    if(run.resumeBlockedReason)c.appendChild(el('div',{className:'callout-body'},'Resume unavailable: '+esc(run.resumeBlockedReason)));
    return
  }
  if(mode==='cancelled'&&run){
    c.className='failed';c.style.borderColor='var(--muted)';c.setAttribute('role','status');c.setAttribute('aria-live','polite');
    c.appendChild(el('div',{className:'callout-title'},'Cancelled'));
    if(run.message)c.appendChild(el('div',{className:'callout-body'},run.message));
    if(run.resumeCommand)c.appendChild(el('div',{className:'callout-body'},'Resume: '+esc(run.resumeCommand)));
    if(run.resumeBlockedReason)c.appendChild(el('div',{className:'callout-body'},'Resume unavailable: '+esc(run.resumeBlockedReason)));
    return
  }
  if(mode==='completed'&&run){
    c.className='completed';c.setAttribute('role','status');c.setAttribute('aria-live','polite');
    c.appendChild(el('div',{className:'callout-title'},'Completed'));
    if(run.message)c.appendChild(el('div',{className:'callout-body'},run.message));
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
  var revision=app.snapshot&&app.snapshot.run&&app.snapshot.run.transcriptRevision||0;
  var summary=(app.snapshot&&app.snapshot.agents||[]).find(function(agent){return agent.name===name});
  var fetchKey=app.runId+':'+name+':'+(summary&&summary.invocationCount||0)+':'+(summary&&summary.status||'')+':'+revision;
  if(name&&app.agentMode!=='closed'&&fetchKey!==app.lastFetchedAgent){
    app.lastFetchedAgent=fetchKey;app.lastTranscriptRevision=revision;fetchAgent(name)
  }else if(name&&app.agentMode!=='closed'&&revision!==app.lastTranscriptRevision){
    app.lastTranscriptRevision=revision;
    if(app.selectedInvocation){var bits=app.selectedInvocation.split(':');if(app.inspectorTab==='files')fetchDiff(bits[0],Number(bits[1]));else fetchTranscript(bits[0],Number(bits[1]))}
  }
}`;
