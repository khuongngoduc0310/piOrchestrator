export const DASHBOARD_CLIENT_RUNTIME = `
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
setTimeout(function(){if(app.connection==='reconnecting')setConnection('disconnected')},30000);`;
