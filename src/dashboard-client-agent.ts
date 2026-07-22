export const DASHBOARD_CLIENT_AGENT = `
function selectAgent(name){
  if(name===app.selectedAgent&&app.agentMode!=='closed'){closeAgent();return}
  app.selectedAgent=name;app.selectedInvocation=null;app.agentMode='manual';app.lastFetchedAgent=null;
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
    var invocations=[];
    (data.steps||[]).forEach(function(s){(s.invocations||[]).forEach(function(inv){invocations.push({step:s,inv:inv,key:s.id+':'+inv.sequence})})});
    if(invocations.length>0){
      if(app.agentMode==='auto'||!app.selectedInvocation||!invocations.some(function(item){return item.key===app.selectedInvocation}))app.selectedInvocation=invocations[invocations.length-1].key;
      panel.appendChild(el('div',{className:'meta'},'Conversation history'));
      var invList=el('div',{className:'invocation-list','aria-label':'Agent invocations'});
      invocations.forEach(function(item){
        var label=item.step.label+' · '+item.inv.mode.replace('_',' ')+' #'+item.inv.sequence;
        var ib=btn(label,{className:'invocation-btn'+(item.key===app.selectedInvocation?' selected':''),title:item.inv.status},function(){
          app.selectedInvocation=item.key;app.agentMode='manual';
          invList.querySelectorAll('.invocation-btn').forEach(function(node){node.classList.toggle('selected',node===ib)});
          fetchTranscript(item.step.id,item.inv.sequence)
        });
        invList.appendChild(ib)
      });
      panel.appendChild(invList);
      panel.appendChild(el('div',{id:'transcript-panel'},[el('div',{className:'empty-state'},'Loading conversation…')]));
      var selected=invocations.find(function(item){return item.key===app.selectedInvocation})||invocations[invocations.length-1];
      fetchTranscript(selected.step.id,selected.inv.sequence)
    }else{
      panel.appendChild(el('div',{className:'empty-state'},'No conversation captured for this agent yet'))
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
function fetchTranscript(stepId,sequence){
  app.transcriptReq++;var req=app.transcriptReq;var target=id('transcript-panel');
  if(!target)return;
  target.innerHTML='<div class="empty-state">Loading conversation…</div>';
  fetch('/api/steps/'+encodeURIComponent(stepId)+'/invocations/'+sequence+'/transcript',{cache:'no-store'}).then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.json()}).then(function(data){
    if(req!==app.transcriptReq)return;renderTranscript(target,data)
  }).catch(function(){if(req===app.transcriptReq&&target)target.innerHTML='<div class="empty-state">Conversation is not available yet</div>'})
}
function renderTranscript(target,data){
  var previous=target.querySelector('.transcript');var open={};var previousScroll=0;var followBottom=true;
  if(previous){previous.querySelectorAll('details[open]').forEach(function(node){open[node.getAttribute('data-detail-key')]=true});previousScroll=previous.scrollTop;followBottom=previous.scrollHeight-previous.scrollTop-previous.clientHeight<40}
  target.innerHTML='';
  if(data.truncated)target.appendChild(el('div',{className:'transcript-note'},'Some conversation content was truncated for safe storage.'));
  var transcript=el('div',{className:'transcript'});var results={};var calls={};
  (data.messages||[]).forEach(function(m){(m.content||[]).forEach(function(part){if(part.type==='toolCall'&&part.toolCallId)calls[part.toolCallId]=true});if(m.role==='toolResult'&&m.toolCallId)results[m.toolCallId]=m});
  (data.messages||[]).forEach(function(m,messageIndex){
    if(m.role==='toolResult'&&m.toolCallId&&calls[m.toolCallId])return;
    var box=el('article',{className:'message '+(m.role==='toolResult'?'tool-result':m.role)+(m.isError?' error':'')});
    box.appendChild(el('div',{className:'message-role'},m.role==='toolResult'?'tool result':m.role));
    renderMessageParts(box,m.content||[],results,'message-'+messageIndex);
    if(m.errorMessage)box.appendChild(el('div',{className:'error-text'},m.errorMessage));
    transcript.appendChild(box)
  });
  if(!transcript.childNodes.length)transcript.appendChild(el('div',{className:'empty-state'},'No messages captured'));
  target.appendChild(transcript);transcript.querySelectorAll('details').forEach(function(node){if(open[node.getAttribute('data-detail-key')])node.open=true});transcript.scrollTop=followBottom?transcript.scrollHeight:previousScroll
}
function renderMessageParts(container,parts,results,keyPrefix){
  parts.forEach(function(part,partIndex){
    if(part.type==='text')container.appendChild(el('div',{className:'message-content'},part.text+(part.truncated?'\\n[content truncated]':'')));
    else if(part.type==='thinking'){
      var thinking=el('details',{className:'thinking','data-detail-key':keyPrefix+'-thinking-'+partIndex});thinking.appendChild(el('summary',null,'Thinking'));
      thinking.appendChild(el('div',{className:'message-content'},part.text+(part.truncated?'\\n[content truncated]':'')));container.appendChild(thinking)
    }else if(part.type==='toolCall'){
      var tool=el('details',{className:'tool-call','data-detail-key':'tool-'+part.toolCallId});tool.appendChild(el('summary',null,part.toolName||'tool'));
      tool.appendChild(el('div',{className:'message-content'},part.arguments||'{}'));
      var result=results[part.toolCallId];if(result){
        var resultBox=el('div',{className:'message tool-result'+(result.isError?' error':'')});
        resultBox.appendChild(el('div',{className:'message-role'},result.isError?'tool error':'tool result'));
        renderMessageParts(resultBox,result.content||[],{},keyPrefix+'-result-'+partIndex);tool.appendChild(resultBox)
      }
      container.appendChild(tool)
    }else if(part.type==='image')container.appendChild(el('div',{className:'muted'},'[image '+(part.mimeType||'')+']'))
  })
}
function closeAgent(){
  app.selectedAgent=null;app.selectedInvocation=null;app.agentMode='closed';app.lastFetchedAgent=null;app.lastTranscriptRevision=-1;app.transcriptReq++;
  var panel=id('agent-inspector');panel.hidden=true;
  id('agent-grid').querySelectorAll('.agent-card').forEach(function(c){c.className='agent-card';c.setAttribute('aria-pressed','false')});
  var agentsEl=id('agents');if(agentsEl&&document.activeElement&&agentsEl.contains(document.activeElement)){} // don't force focus
}`;
