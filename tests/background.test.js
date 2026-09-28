import test from 'node:test';
import assert from 'node:assert/strict';
import {digest,ORIGIN,campusDay,nextNine} from '../extension/core.js';
const db={},alarms=new Map();
const event=()=>({listeners:[],addListener(fn){this.listeners.push(fn);}});
let portalCalls=0,requests=0,failDetail=false;
const label='Test Student', course={id:'_1_1',name:'Test course',code:'CS100-2026FA',url:ORIGIN+'/webapps/blackboard/execute/launcher?type=Course&id=_1_1&url=',term:'Term'};
const page=ORIGIN+'/webapps/blackboard/content/listContent.jsp?course_id=_1_1&content_id=_2_1';
const detail=ORIGIN+'/webapps/assignment/uploadAssignment?course_id=_1_1&content_id=_3_1&mode=view';
globalThis.chrome={
  storage:{local:{async get(k){return {[k]:structuredClone(db[k])};},async set(d){Object.assign(db,structuredClone(d));},async remove(k){delete db[k];}}},
  runtime:{id:'test',getPlatformInfo:async()=>({os:'mac'}),getURL:p=>'chrome-extension://test/'+p,getContexts:async()=>[{}],onMessage:event(),onStartup:event(),onInstalled:event(),
    sendNativeMessage:async()=>{throw new Error('No host');},sendMessage:async msg=>{
      if(msg.kind==='identity')return {ok:true,data:{userId:'_42_1'}};
      if(msg.kind==='enrollments')return {ok:true,data:{terms:[{id:'_58_1',name:'2026秋（Fall 2026）',duration:'从 2026年7月10日 至 2027年3月1日'}],courses:[course]}};
      if(msg.kind==='course')return {ok:true,data:{valid:true,pages:[{url:page,title:'Lectures'}],files:[],assignments:[],notes:[]}};
      if(msg.kind==='content')return {ok:true,data:{valid:true,pages:[],files:[],notes:[],assignments:[{id:'_3_1',title:'Homework',url:detail,due:null,status:'unknown'}]}};
      if(msg.kind==='detail')return {ok:true,data:{due:'2026-09-27T15:59:00.000Z',status:'unknown',dueRaw:'Sep 27 11:59 PM'}};
      if(msg.kind==='grades')return {ok:true,data:[{title:'Homework',status:'submitted'}]};
    }},
  tabs:{async create(){portalCalls++;return{id:1};},async get(){return{status:'complete',url:ORIGIN+'/webapps/portal/execute/tabs/tabAction'};},async remove(){}},
  scripting:{executeScript:async()=>[{result:{label,settingsURL:ORIGIN+'/webapps/portal/execute/tabs/tabAction?tab_tab_group_id=_1_1&forwardUrl=edit_module%2F_3_1%2Fbbcourseorg%3Fcmd%3Dedit'}}]},
  alarms:{async get(k){return alarms.get(k)||{name:k};},async create(k,v){alarms.set(k,v);},async clear(k){return alarms.delete(k);},onAlarm:event()},
  action:{onClicked:event()},downloads:{onChanged:event(),cancelled:[],async cancel(id){this.cancelled.push(id);return true;}},offscreen:{}
};
globalThis.fetch=async url=>{
  requests++;
  if(failDetail&&url===detail)throw new Error('offline during assignment detail');
  const r=new Response(url.includes('calendarData')?'[]':'fixture',{headers:{'content-type':url.includes('calendarData')?'application/json':'text/html'}});
  Object.defineProperty(r,'url',{value:url});return r;
};
await import('../extension/background.js');
async function settle(predicate){for(let i=0;i<1000;i++){if(predicate())return;await new Promise(r=>setImmediate(r));}throw new Error('Worker did not settle');}
const fire=async name=>{chrome.alarms.onAlarm.listeners[0]({name});await settle(()=>db.state?.job||db.state?.lastSync||db.state?.lastError);};
test('daily job survives queue checkpoints and does not repeat the same day',async()=>{
  const realNow=Date.now;Date.now=()=>Date.parse('2026-09-26T10:00:00+08:00');
  try{
    db.state={account:(await digest(label)).slice(0,24),accountLabel:label,courses:[],assignments:[],files:{},warnings:[],enabled:true};
    await fire('daily-nine');await settle(()=>alarms.has('resume-job'));
    assert.equal(db.state.lastAutoDay,'2026-09-26');
    await fire('resume-job');await settle(()=>db.state.lastSync&&!db.state.job);
    assert.equal(db.state.assignments[0].due,'2026-09-27T15:59:00.000Z');
    assert.equal(db.state.assignments[0].status,'submitted');
    const count=portalCalls;
    chrome.alarms.onAlarm.listeners[0]({name:'daily-nine'});await new Promise(r=>setImmediate(r));
    assert.equal(portalCalls,count);assert.equal(alarms.get('daily-nine').when,nextNine());
    assert.ok([...alarms.values()].every(a=>!a.periodInMinutes),'no periodic course polling');
    const ask=msg=>new Promise(resolve=>chrome.runtime.onMessage.listeners[0](msg,{id:'test',url:chrome.runtime.getURL('index.html')},resolve));
    assert.equal((await ask({op:'settings',enabled:true,selected:db.state.courses.map(c=>c.id),checkTime:'25:00'})).ok,false);
    assert.equal((await ask({op:'settings',enabled:true,selected:db.state.courses.map(c=>c.id),checkTime:'21:30'})).ok,true);
    assert.equal(db.state.checkTime,'21:30');assert.equal(alarms.get('daily-nine').when,Date.parse('2026-09-26T21:30:00+08:00'),'alarm re-armed at the new time');
    await ask({op:'settings',enabled:true,selected:db.state.courses.map(c=>c.id)});assert.equal(db.state.checkTime,'21:30','course saves keep the time');
    chrome.alarms.onAlarm.listeners[0]({name:'daily-nine'});await new Promise(r=>setImmediate(r));assert.equal(portalCalls,count,'still once per campus day');
    db.state.checkTime=undefined;
  }finally{Date.now=realNow;}
});
test('failed detail preserves a previously known due date and records a warning',async()=>{
  const realNow=Date.now;Date.now=()=>Date.parse('2026-09-27T10:00:00+08:00');
  try{
    failDetail=true;db.state.lastSync=null;
    await fire('daily-nine');await settle(()=>db.state.job?.gradesQueued);
    await fire('resume-job');await settle(()=>db.state.lastSync&&!db.state.job);
    assert.equal(db.state.assignments[0].due,'2026-09-27T15:59:00.000Z');
    assert.ok(db.state.warnings.some(w=>w.includes('offline')));
    assert.ok(db.state.assignments[0].checked<db.state.lastRun);
  }finally{Date.now=realNow;failDetail=false;}
});

test('download -> native archive preserves filename, and a second scan skips unchanged files',async()=>{
  let downloads=0,archives=0,relocations=0;
  const url=ORIGIN+'/bbcswebdav/pid-3-dt-content-rid-99_1/xid-99_1';
  const key='_1_1:99_1';
  db.state={integrationMode:'macos',account:'test',courses:[{...course,enabled:true}],assignments:[],warnings:[],enabled:true,lastSync:1,lastRun:1,files:{[key]:{key,id:'99_1',name:'Lecture',courseId:'_1_1',url,relative:['Term','Course','Lecture'],seen:1}}};
  chrome.runtime.sendNativeMessage=async (_,msg)=>{
    if(msg.op==='status')return{ok:true,root:'/archive'};
    if(msg.op==='exists')return{ok:true,exists:true};
    if(msg.op==='relocate'){
      relocations++;assert.deepEqual(msg.sourceRelative,['Term','Course','lecture.pdf']);assert.equal(msg.sha256,'test-hash');
      return{ok:true,moved:true,path:'/archive/'+msg.relative.join('/'),relative:msg.relative,sha256:msg.sha256};
    }
    if(msg.op==='archive'){archives++;return{ok:true,path:'/archive/'+msg.relative.join('/'),relative:msg.relative,sha256:'test-hash'};}
    throw new Error('unexpected native call');
  };
  chrome.downloads.download=async()=>{downloads++;return 1;};
  chrome.downloads.search=async()=>[{state:'complete',danger:'safe',mime:'application/pdf',filename:'/downloads/BBReader-staging/fixture/lecture.pdf'}];
  globalThis.fetch=async u=>{const r=new Response(null,{headers:{'content-type':'application/pdf','etag':'v1','content-disposition':'attachment; filename="lecture.pdf"'}});Object.defineProperty(r,'url',{value:u});return r;};
  await fire('download-next');await settle(()=>db.state.files[key].sha256);
  assert.equal(db.state.files[key].savedPath,'/archive/Term/Course/lecture.pdf');
  db.state.lastSync=2;
  await new Promise(r=>setImmediate(r));
  await fire('download-next');await settle(()=>db.state.files[key].checkedRun===2);
  assert.equal(downloads,1);assert.equal(archives,1);
  db.state.lastSync=3;db.state.files[key].relative=['Term','Course','Lab 1','lecture.pdf'];
  await new Promise(r=>setImmediate(r));
  await fire('download-next');await settle(()=>db.state.files[key].checkedRun===3);
  assert.equal(relocations,1);assert.equal(downloads,1);assert.equal(archives,1);
  assert.equal(db.state.files[key].savedPath,'/archive/Term/Course/Lab 1/lecture.pdf');
  assert.deepEqual(db.state.files[key].savedRelative,db.state.files[key].relative);
});

test('Reminders receives course titles and only checked selected assignments; completion is kept separate',async()=>{
  await new Promise(r=>setTimeout(r,1100));
  const account='a'.repeat(24);let payload;
  db.state={integrationMode:'macos',account,courses:[{id:'_1_1',enabled:true},{id:'_9_1',enabled:false}],assignments:[
    {id:'_3_1',courseId:'_1_1',courseName:'Compilers',title:'Assignment1',url:detail,due:'2026-09-27T15:59:00Z',checked:100,status:'unknown'},
    {id:'_4_1',courseId:'_1_1',courseName:'Compilers',title:'Stale',checked:99},
    {id:'_5_1',courseId:'_9_1',courseName:'Other',title:'Disabled course',checked:100}],files:{},warnings:[],lastSync:101,lastRun:100};
  chrome.runtime.sendNativeMessage=async(_,msg)=>{payload=msg;return {ok:true,list:'BBReader · 作业',created:1,updated:0,completed:{'_1_1:_3_1':true}};};
  const result=await new Promise(resolve=>chrome.runtime.onMessage.listeners[0]({op:'connectReminders'},{id:'test',url:chrome.runtime.getURL('index.html')},resolve));
  assert.equal(result.ok,true);assert.equal(payload.assignments.length,1);assert.equal(payload.assignments[0].courseName,'Compilers');
  assert.deepEqual(payload.removeCourses,['_9_1'],'unticked courses are cleaned from Reminders');assert.ok(!('notes' in payload.assignments[0]),'no notes are sent');
  assert.equal(db.state.assignments[0].reminderCompleted,true);assert.equal(db.state.assignments[0].status,'unknown');
  assert.equal(db.state.remindersEnabled,true);
  const paused=await new Promise(resolve=>chrome.runtime.onMessage.listeners[0]({op:'pauseReminders'},{id:'test',url:chrome.runtime.getURL('index.html')},resolve));
  assert.equal(paused.ok,true);assert.equal(db.state.remindersEnabled,false);assert.equal(db.state.assignments.length,3);
});

test('a failed scan retains the CAS retry pause rather than overwriting it with stale scan state',async()=>{
  db.state={courses:[],assignments:[],files:{},warnings:[],credentialLogin:true};
  let scripts=0,reads=0;
  chrome.permissions={contains:async()=>true};
  chrome.tabs.get=async()=>({status:'complete',url:'https://cas.sustech.edu.cn/cas/login'});
  chrome.scripting.executeScript=async()=>[{result:['ready','submitted','rejected'][scripts++]}];
  chrome.runtime.sendNativeMessage=async()=>{reads++;return {ok:true,configured:true,username:'fixture',password:'not-a-real-password'};};
  await new Promise(resolve=>chrome.runtime.onMessage.listeners[0]({op:'sync'},{id:'test',url:chrome.runtime.getURL('index.html')},resolve));
  await new Promise(r=>setTimeout(r,650));
  assert.equal(reads,1);assert.equal(db.state.authBlocked,true);assert.match(db.state.lastError,/学校拒绝/);
});

test('folder selection cancels without changes, saves root/course choices, and rescans only affected files',async()=>{
  db.state={integrationMode:'macos',courses:[{id:'_1_1',name:'Course 1'}],assignments:[],files:{a:{courseId:'_1_1',checkedRun:7},b:{courseId:'_2_1',checkedRun:7}},warnings:[]};
  let cancel=true,saved=[],lastPicker;
  chrome.runtime.sendNativeMessage=async(host,msg)=>{
    if(host==='cn.sustech.bbreader.picker'){lastPicker=msg;return cancel?{ok:true,cancelled:true}:{ok:true,path:'/Users/fixture/chosen'};}
    if(msg.op==='status')return {ok:true,root:'/Users/fixture/root',courses:{'_1_1':'/Users/fixture/course'}};
    saved.push(msg);return {ok:true,root:'/Users/fixture/chosen',courses:{'_1_1':'/Users/fixture/chosen'}};
  };
  const ask=msg=>new Promise(resolve=>chrome.runtime.onMessage.listeners[0](msg,{id:'test',url:chrome.runtime.getURL('index.html')},resolve));
  const before=structuredClone(db.state);
  assert.equal((await ask({op:'chooseRoot'})).cancelled,true);assert.deepEqual(db.state,before);assert.equal(saved.length,0);
  cancel=false;assert.equal((await ask({op:'chooseCourse',courseId:'_1_1'})).ok,true);
  assert.equal(lastPicker.directory,'/Users/fixture/course');assert.equal(saved[0].op,'setCourse');assert.equal(saved[0].courseId,'_1_1');assert.equal(db.state.files.a.checkedRun,null);assert.equal(db.state.files.b.checkedRun,7);
  assert.equal((await ask({op:'chooseRoot'})).ok,true);assert.equal(saved[1].op,'setRoot');assert.equal(db.state.files.b.checkedRun,null);
  assert.equal((await ask({op:'chooseCourse',courseId:'_9_1'})).ok,false);
});

// Index-only checks and aborting a queue are driven through the same message API the UI uses.
const send=msg=>new Promise(resolve=>chrome.runtime.onMessage.listeners[0](msg,{id:'test',url:chrome.runtime.getURL('index.html')},resolve));
const contentURL=ORIGIN+'/bbcswebdav/pid-3-dt-content-rid-99_1/xid-99_1';
function serveAttachments(){
  const previous=globalThis.fetch;
  globalThis.fetch=async (url,options)=>{
    const head=options?.method==='HEAD';
    const r=new Response(head?null:url.includes('calendarData')?'[]':'fixture',{headers:head?{'content-type':'application/pdf',etag:'v1','content-disposition':'attachment; filename="lecture.pdf"'}:{'content-type':url.includes('calendarData')?'application/json':'text/html'}});
    Object.defineProperty(r,'url',{value:url});return r;
  };
  return previous;
}
// The queue re-arms itself through a 1s timer; the browser suite disables it the same way so tests drive alarms explicitly.
const quietQueue=()=>{const previous=globalThis.setTimeout;globalThis.setTimeout=(fn,ms,...args)=>ms===1000?0:previous(fn,ms,...args);return previous;};

test('an index-only check leaves indexed files unsaved until the user downloads them',async()=>{
  const fetchBack=serveAttachments(),timeoutBack=quietQueue();
  const downloadBack=chrome.downloads.download,searchBack=chrome.downloads.search;
  let downloadCalls=0;
  chrome.downloads.download=async()=>{downloadCalls++;return 1;};
  chrome.downloads.search=async()=>[{id:1,state:'complete',danger:'safe',mime:'application/pdf',filename:'C:\\downloads\\BBReader\\lecture.pdf',exists:true,fileSize:12}];
  alarms.delete('download-next');
  const realNow=Date.now;Date.now=()=>Date.parse('2026-09-28T10:00:00+08:00');
  try{
    // A pending job whose crawl already finished, so one pass reaches the end of the check.
    db.state={account:'test',accountLabel:label,enabled:true,integrationMode:'browser',autoDownload:false,lastSync:10,lastRun:10,
      courses:[{...course,enabled:true}],assignments:[],warnings:[],
      job:{queue:[],seen:[],done:0,started:10,gradesQueued:true},
      files:{'_1_1:99_1':{key:'_1_1:99_1',id:'99_1',name:'lecture.pdf',courseId:'_1_1',url:contentURL,relative:['Term','Test course','Lectures','lecture.pdf'],seen:10}}};
    await send({op:'sync'});
    await settle(()=>db.state.downloadStatus==='索引已更新，未下载');
    assert.equal(db.state.job,null,'the check finished');
    const indexed=Object.values(db.state.files);
    assert.equal(indexed.length,1,'the index is kept');
    assert.equal(indexed[0].seen,db.state.lastRun);
    assert.equal(indexed[0].checkedRun,undefined,'nothing was archived');
    assert.equal(downloadCalls,0,'an index-only check must not download');
    assert.ok(!alarms.has('download-next'),'no queue watchdog is armed');
    assert.equal((await send({op:'state'})).downloading,false,'an idle queue reports no activity');
    assert.equal((await send({op:'files'})).ok,true);
    await settle(()=>Object.values(db.state.files).every(f=>f.browserDownload));
    assert.equal(downloadCalls,1,'the files view still downloads on demand');
  }finally{Date.now=realNow;globalThis.setTimeout=timeoutBack;globalThis.fetch=fetchBack;chrome.downloads.download=downloadBack;chrome.downloads.search=searchBack;}
});

test('aborting a queue cancels the in-flight download, clears the watchdog and stays stopped',async()=>{
  const fetchBack=serveAttachments(),timeoutBack=quietQueue();
  const downloadBack=chrome.downloads.download,searchBack=chrome.downloads.search;
  let downloadCalls=0;
  chrome.downloads.cancelled.length=0;
  chrome.downloads.download=async()=>{downloadCalls++;return 7;};
  chrome.downloads.search=async()=>[{id:7,state:'in_progress',danger:'safe',mime:'application/pdf',filename:'C:\\downloads\\BBReader\\lecture.pdf',exists:true,fileSize:0}];
  try{
    delete db.pending;alarms.delete('download-next');
    db.state={integrationMode:'browser',account:'test',courses:[{...course,enabled:true}],assignments:[],warnings:[],enabled:true,lastRun:5,lastSync:6,
      files:{'_1_1:99_1':{key:'_1_1:99_1',id:'99_1',name:'lecture.pdf',courseId:'_1_1',url:contentURL,relative:['Term','Test course','Lectures','lecture.pdf'],seen:5}}};
    assert.equal((await send({op:'files'})).ok,true);
    await settle(()=>Object.keys(db.pending||{}).length);
    assert.equal(downloadCalls,1);
    assert.equal((await send({op:'state'})).downloading,true,'an armed queue reports activity');
    assert.equal((await send({op:'abortDownload'})).ok,true);
    assert.equal(db.state.downloadAbort,true);
    assert.deepEqual(chrome.downloads.cancelled,[7],'the in-flight transfer is cancelled');
    assert.equal(Object.keys(db.pending).length,0,'staged work is dropped');
    assert.ok(!alarms.has('download-next'),'the watchdog is cleared');
    assert.equal((await send({op:'state'})).downloading,false);
    chrome.alarms.onAlarm.listeners[0]({name:'download-next'});await new Promise(r=>setImmediate(r));
    assert.equal(downloadCalls,1,'an aborted queue stays stopped');
    chrome.downloads.search=async()=>[{id:8,state:'complete',danger:'safe',mime:'application/pdf',filename:'C:\\downloads\\BBReader\\lecture.pdf',exists:true,fileSize:12}];
    assert.equal((await send({op:'files'})).ok,true);
    await settle(()=>downloadCalls===2);
    assert.equal(db.state.downloadAbort,false,'an explicit download clears the abort');
  }finally{globalThis.setTimeout=timeoutBack;globalThis.fetch=fetchBack;chrome.downloads.download=downloadBack;chrome.downloads.search=searchBack;}
});

test('unticked files are skipped and ticking them again downloads them',async()=>{
  const fetchBack=serveAttachments(),timeoutBack=quietQueue();
  const downloadBack=chrome.downloads.download,searchBack=chrome.downloads.search;
  let downloadCalls=0;
  chrome.downloads.download=async()=>{downloadCalls++;return downloadCalls;};
  chrome.downloads.search=async q=>[{id:q.id,state:'complete',danger:'safe',mime:'application/pdf',filename:'C:\\downloads\\BBReader\\x.pdf',exists:true,fileSize:12}];
  const entry=i=>({key:`_1_1:99${i}_1`,id:`99${i}_1`,name:`file${i}.pdf`,courseId:'_1_1',url:ORIGIN+`/bbcswebdav/xid-99${i}_1`,relative:['Term','Test course',`file${i}.pdf`],seen:5});
  try{
    delete db.pending;alarms.delete('download-next');
    // The excluded file comes first in insertion order, so the queue would reach it first without the flag.
    db.state={integrationMode:'browser',account:'test',courses:[{...course,enabled:true}],assignments:[],warnings:[],enabled:true,lastRun:5,lastSync:6,
      files:{'_1_1:991_1':{...entry(1),wanted:false},'_1_1:992_1':entry(2)}};
    assert.equal((await send({op:'files'})).ok,true);
    await settle(()=>db.state.files['_1_1:992_1'].browserDownload);
    assert.equal(downloadCalls,1,'the ticked file is downloaded');
    assert.equal(db.state.files['_1_1:991_1'].browserDownload,undefined,'the unticked file is skipped even though it comes first');
    assert.equal(db.state.files['_1_1:991_1'].checkedRun,undefined,'the unticked file is not even checked');
    assert.equal((await send({op:'fileSelection',changed:'nope'})).ok,false,'a malformed selection is rejected');
    assert.equal((await send({op:'fileSelection',changed:[['_1_1:991_1',true]]})).ok,true);
    assert.equal('wanted' in db.state.files['_1_1:991_1'],false,'ticking a file again drops the exclusion');
    assert.equal((await send({op:'files'})).ok,true);
    await settle(()=>db.state.files['_1_1:991_1'].browserDownload);
    assert.equal(downloadCalls,2,'the reticked file downloads on request');
    assert.equal((await send({op:'fileSelection',changed:[['_1_1:992_1',false]]})).ok,true);
    assert.equal(db.state.files['_1_1:992_1'].wanted,false,'exclusions are stored on the file');
    assert.match(db.state.files['_1_1:992_1'].browserDownload.path,/x\.pdf$/,'unticking never deletes a saved file');
  }finally{globalThis.setTimeout=timeoutBack;globalThis.fetch=fetchBack;chrome.downloads.download=downloadBack;chrome.downloads.search=searchBack;}
});
