export const DASHBOARD_CLIENT_AGENT = `
function runApi(suffix){return '/api/runs/'+encodeURIComponent(app.runId)+suffix}
function selectAgent(name){
  if(name===app.selectedAgent&&app.agentMode==='pinned'){closeAgent();return}
  app.selectedAgent=name;app.selectedInvocation=null;app.agentMode='pinned';app.lastFetchedAgent=null;app.inspectorTab='transcript';app.currentTranscript=null;
  updateAgentSelection(name)
}
function setAgentAuto(){
  app.agentMode='auto';var active=app.snapshot&&app.snapshot.run&&app.snapshot.run.activeAgent;
  if(active){app.selectedAgent=active;app.selectedInvocation=null;app.lastFetchedAgent=null;updateAgentSelection(active)}
}
function fetchAgent(name){
  app.agentReq++;var req=app.agentReq;var panel=id('agent-inspector');
  panel.innerHTML='<div class="empty-state"><p>Loading agent history…</p></div>';panel.removeAttribute('hidden');id('agents').querySelector('.agents-layout').classList.add('show-inspector');
  fetch(runApi('/agents/'+encodeURIComponent(name)),{cache:'no-store'}).then(function(r){if(!r.ok)return null;return r.json()}).then(function(data){
    if(req!==app.agentReq||app.selectedAgent!==name)return;
    if(!data){panel.innerHTML='<div class="empty-state"><p>No agent history available</p></div>';return}
    panel.innerHTML='';
    var header=el('div',{className:'closable-header',style:'display:flex;justify-content:space-between;align-items:center;gap:8px'});
    header.appendChild(el('h3',null,data.name+' '));header.querySelector('h3').appendChild(el('span',{className:'muted'},data.status));
    var headerActions=el('div',{className:'inspector-controls'});
    headerActions.appendChild(btn(app.agentMode==='auto'?'Following active':'Auto follow',{className:'close-btn'},setAgentAuto));
    headerActions.appendChild(btn('Close',{className:'close-btn'},closeAgent));header.appendChild(headerActions);panel.appendChild(header);
    if(data.model)panel.appendChild(el('div',{className:'meta'},'Model: '+data.model));
    if(data.startedAt)panel.appendChild(el('div',{className:'meta'},'Started: '+data.startedAt.slice(0,19).replace('T',' ')));
    if(data.completedAt)panel.appendChild(el('div',{className:'meta'},'Completed: '+data.completedAt.slice(0,19).replace('T',' ')));
    if(data.summary)panel.appendChild(el('p',{className:'meta'},trunc(data.summary,200)));
    if(data.error)panel.appendChild(el('p',{className:'error-text'},data.error));
    if(data.currentTool)panel.appendChild(el('div',{className:'tool-row'},'Tool: '+data.currentTool+(data.currentToolArgs?' · '+trunc(data.currentToolArgs,120):'')));
    var invocations=[];(data.steps||[]).forEach(function(step){(step.invocations||[]).forEach(function(inv){invocations.push({step:step,inv:inv,key:step.id+':'+inv.sequence})})});app.invocations=invocations;
    if(invocations.length){
      if(!app.selectedInvocation||!invocations.some(function(item){return item.key===app.selectedInvocation}))app.selectedInvocation=invocations[invocations.length-1].key;
      panel.appendChild(el('div',{className:'meta'},'Conversation history'));
      var list=el('div',{className:'invocation-list','aria-label':'Agent invocations'});
      invocations.forEach(function(item){
        var files=item.inv.changedFileCount===undefined?'':' · '+item.inv.changedFileCount+' files';
        var button=btn(item.step.label+' · '+item.inv.mode.replace('_',' ')+' #'+item.inv.sequence+files,{className:'invocation-btn'+(item.key===app.selectedInvocation?' selected':''),title:item.inv.status},function(){
          app.selectedInvocation=item.key;app.agentMode='pinned';list.querySelectorAll('.invocation-btn').forEach(function(node){node.classList.toggle('selected',node===button)});renderInvocationViewer(item)
        });list.appendChild(button)
      });panel.appendChild(list);panel.appendChild(el('div',{id:'invocation-panel'}));
      var selected=invocations.find(function(item){return item.key===app.selectedInvocation})||invocations[invocations.length-1];renderInvocationViewer(selected)
    }else panel.appendChild(el('div',{className:'empty-state'},'No invocations captured for this agent'));
    if(data.steps&&data.steps.length){
      var details=el('details');details.appendChild(el('summary',null,'Steps ('+data.steps.length+')'));var listEl=el('ul',{className:'step-list'});
      data.steps.forEach(function(step){var li=el('li',null,(step.startedAt?step.startedAt.slice(11,19)+' ':'')+step.label+(step.message?' · '+step.message:''));if(step.artifact)li.appendChild(artBtn(step.artifact));if(step.rawArtifact)li.appendChild(artBtn(step.rawArtifact));if(step.mutationArtifact)li.appendChild(artBtn(step.mutationArtifact));listEl.appendChild(li)});details.appendChild(listEl);panel.appendChild(details)
    }
  }).catch(function(){if(req===app.agentReq)panel.innerHTML='<p class="error-text">Failed to load agent details</p>'})
}
function renderInvocationViewer(item){
  var target=id('invocation-panel');if(!target)return;target.innerHTML='';
  var controls=el('div',{className:'inspector-controls'});var tabs=el('div',{className:'inspector-tabs'});
  var transcriptTab=btn('Transcript',{className:'close-btn inspector-tab'+(app.inspectorTab==='transcript'?' active':'')},function(){app.inspectorTab='transcript';renderInvocationViewer(item)});
  var filesTab=btn('Files'+(item.inv.changedFileCount===undefined?'':' ('+item.inv.changedFileCount+')'),{className:'close-btn inspector-tab'+(app.inspectorTab==='files'?' active':'')},function(){app.inspectorTab='files';renderInvocationViewer(item)});
  tabs.appendChild(transcriptTab);tabs.appendChild(filesTab);controls.appendChild(tabs);
  if(app.inspectorTab==='transcript'){
    var search=el('input',{className:'transcript-search',type:'search',placeholder:'Search transcript','aria-label':'Search transcript',value:app.transcriptQuery});search.value=app.transcriptQuery;
    search.addEventListener('input',function(){app.transcriptQuery=this.value;if(app.currentTranscript)renderTranscript(id('invocation-content'),app.currentTranscript)});controls.appendChild(search)
  }
  target.appendChild(controls);target.appendChild(el('div',{id:'invocation-content'},[el('div',{className:'empty-state'},'Loading…')]));
  if(app.inspectorTab==='files')fetchDiff(item.step.id,item.inv.sequence);else fetchTranscript(item.step.id,item.inv.sequence)
}
function fetchTranscript(stepId,sequence){
  app.transcriptReq++;var req=app.transcriptReq;var target=id('invocation-content');if(!target)return;
  fetch(runApi('/steps/'+encodeURIComponent(stepId)+'/invocations/'+sequence+'/transcript'),{cache:'no-store'}).then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.json()}).then(function(data){if(req!==app.transcriptReq)return;app.currentTranscript=data;renderTranscript(target,data)}).catch(function(){if(req===app.transcriptReq&&target)target.innerHTML='<div class="empty-state">Conversation is not available</div>'})
}
function appendHighlighted(container,text){
  var query=app.transcriptQuery.trim();if(!query){container.appendChild(document.createTextNode(text));return}
  var lower=text.toLowerCase(),needle=query.toLowerCase(),offset=0,index;
  while((index=lower.indexOf(needle,offset))>=0){if(index>offset)container.appendChild(document.createTextNode(text.slice(offset,index)));container.appendChild(el('mark',null,text.slice(index,index+query.length)));offset=index+query.length}
  if(offset<text.length)container.appendChild(document.createTextNode(text.slice(offset)))
}
function renderTranscript(target,data){
  target.innerHTML='';if(data.truncated)target.appendChild(el('div',{className:'transcript-note'},'Some conversation content was truncated.'));
  var transcript=el('div',{className:'transcript'});var results={},calls={};
  (data.messages||[]).forEach(function(message){(message.content||[]).forEach(function(part){if(part.type==='toolCall'&&part.toolCallId)calls[part.toolCallId]=true});if(message.role==='toolResult'&&message.toolCallId)results[message.toolCallId]=message});
  (data.messages||[]).forEach(function(message,messageIndex){
    if(message.role==='toolResult'&&message.toolCallId&&calls[message.toolCallId])return;
    var box=el('article',{className:'message '+(message.role==='toolResult'?'tool-result':message.role)+(message.isError?' error':'')});box.appendChild(el('div',{className:'message-role'},message.role==='toolResult'?'tool result':message.role));
    renderMessageParts(box,message.content||[],results,'message-'+messageIndex);if(message.errorMessage)box.appendChild(el('div',{className:'error-text'},message.errorMessage));
    if(!app.transcriptQuery||box.textContent.toLowerCase().indexOf(app.transcriptQuery.toLowerCase())>=0)transcript.appendChild(box)
  });
  if(!transcript.childNodes.length)transcript.appendChild(el('div',{className:'empty-state'},app.transcriptQuery?'No transcript matches':'No messages captured'));target.appendChild(transcript);transcript.scrollTop=transcript.scrollHeight
}
function renderMessageParts(container,parts,results,keyPrefix){
  parts.forEach(function(part,partIndex){
    if(part.type==='text'){var text=el('div',{className:'message-content'});appendHighlighted(text,part.text+(part.truncated?'\\n[content truncated]':''));container.appendChild(text)}
    else if(part.type==='thinking'){var thinking=el('details',{className:'thinking','data-detail-key':keyPrefix+'-thinking-'+partIndex});thinking.appendChild(el('summary',null,'Thinking'));var thought=el('div',{className:'message-content'});appendHighlighted(thought,part.text+(part.truncated?'\\n[content truncated]':''));thinking.appendChild(thought);container.appendChild(thinking)}
    else if(part.type==='toolCall'){var tool=el('details',{className:'tool-call','data-detail-key':'tool-'+part.toolCallId});tool.appendChild(el('summary',null,part.toolName||'tool'));var args=el('div',{className:'message-content'});appendHighlighted(args,part.arguments||'{}');tool.appendChild(args);var result=results[part.toolCallId];if(result){var resultBox=el('div',{className:'message tool-result'+(result.isError?' error':'')});resultBox.appendChild(el('div',{className:'message-role'},result.isError?'tool error':'tool result'));renderMessageParts(resultBox,result.content||[],{},keyPrefix+'-result-'+partIndex);tool.appendChild(resultBox)}container.appendChild(tool)}
    else if(part.type==='image')container.appendChild(el('div',{className:'muted'},'[image '+(part.mimeType||'')+']'))
  })
}
function fetchDiff(stepId,sequence){
  app.diffReq++;var req=app.diffReq;var target=id('invocation-content');if(!target)return;
  fetch(runApi('/steps/'+encodeURIComponent(stepId)+'/invocations/'+sequence+'/diff'),{cache:'no-store'}).then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.json()}).then(function(data){if(req===app.diffReq)renderDiff(target,data)}).catch(function(){if(req===app.diffReq)target.innerHTML='<div class="empty-state">File diff is not available for this invocation</div>'})
}
function patchSections(patch){
  var lines=patch.split('\\n'),sections=[],current=[];lines.forEach(function(line){if(line.indexOf('diff --git ')===0&&current.length){sections.push(current.join('\\n'));current=[]}current.push(line)});if(current.length&&current.some(function(line){return line.length}))sections.push(current.join('\\n'));return sections
}
function diffPath(file){return file.status.charAt(0)==='D'?(file.oldPath||''):(file.newPath||file.oldPath||'')}
function renderDiff(target,data){
  target.innerHTML='';var metadata=data.metadata||{};
  if(metadata.status!=='available'){target.appendChild(el('div',{className:'empty-state'},metadata.unavailableReason||'Textual diff is unavailable'));return}
  if(data.patchTruncated)target.appendChild(el('div',{className:'transcript-note'},'Patch preview was truncated. The persisted artifact remains authoritative.'));
  if(!metadata.files||!metadata.files.length){target.appendChild(el('div',{className:'empty-state'},'No file changes in this invocation'));return}
  if(app.selectedDiffFile>=metadata.files.length)app.selectedDiffFile=0;var layout=el('div',{className:'diff-layout'}),tree=el('div',{className:'diff-files'}),viewer=el('div',{className:'unified-diff','aria-label':'Unified diff'}),sections=patchSections(data.patch||'');
  function show(index){app.selectedDiffFile=index;tree.querySelectorAll('.diff-file').forEach(function(button,i){button.classList.toggle('selected',i===index)});viewer.innerHTML='';var file=metadata.files[index];if(file.binary){viewer.appendChild(el('span',{className:'diff-line meta'},'Binary change · '+file.status+' · '+diffPath(file)));return}var section=sections[index]||'';if(!section){viewer.appendChild(el('span',{className:'diff-line meta'},'No textual patch for '+diffPath(file)));return}section.split('\\n').forEach(function(line){var cls='diff-line';if(line.indexOf('@@')===0)cls+=' hunk';else if(line.charAt(0)==='+'&&line.indexOf('+++')!==0)cls+=' add';else if(line.charAt(0)==='-'&&line.indexOf('---')!==0)cls+=' del';else if(line.indexOf('diff --git')===0||line.indexOf('index ')===0||line.indexOf('---')===0||line.indexOf('+++')===0)cls+=' meta';viewer.appendChild(el('span',{className:cls},line+'\\n'))})}
  metadata.files.forEach(function(file,index){var button=btn(file.status+' '+diffPath(file),{className:'diff-file'+(index===app.selectedDiffFile?' selected':'')},function(){show(index)});tree.appendChild(button)});layout.appendChild(tree);layout.appendChild(viewer);target.appendChild(layout);show(app.selectedDiffFile)
}
function closeAgent(){
  app.selectedAgent=null;app.selectedInvocation=null;app.agentMode='closed';app.lastFetchedAgent=null;app.lastTranscriptRevision=-1;app.currentTranscript=null;app.agentReq++;app.transcriptReq++;app.diffReq++;
  var panel=id('agent-inspector');panel.hidden=true;panel.innerHTML='';id('agents').querySelector('.agents-layout').classList.remove('show-inspector');id('agent-grid').querySelectorAll('.agent-card').forEach(function(card){card.className='agent-card';card.setAttribute('aria-pressed','false')})
}`;
