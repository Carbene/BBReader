import test from 'node:test';
import assert from 'node:assert/strict';
import {ORIGIN,digest} from '../extension/core.js';
import {installFakeIndexedDB} from './fake-idb.js';
installFakeIndexedDB();
const event=()=>({listeners:[],addListener(fn){this.listeners.push(fn);}});
const db={},alarms=new Map(),downloads=[];
let os='win',nativeCalls=0,downloadCalls=0;
const course={id:'_1_1',name:'Course 2026 Fall',code:'CS100-2026FA',term:'2026秋（Fall 2026）',url:ORIGIN+'/webapps/blackboard/execute/launcher?type=Course&id=_1_1'};
const page=ORIGIN+'/webapps/blackboard/content/listContent.jsp?course_id=_1_1&content_id=_2_1';
const detail=ORIGIN+'/webapps/assignment/uploadAssignment?course_id=_1_1&content_id=_3_1&mode=view';
const files=[1,2].map(i=>({id:`99${i}_1`,url:ORIGIN+`/bbcswebdav/xid-99${i}_1`,name:`file${i}.pdf`,itemFolder:'Lab 1'}));
const realTimeout=globalThis.setTimeout;
globalThis.setTimeout=(fn,ms,...args)=>ms===1000?0:realTimeout(fn,ms,...args); // Drive queue alarms explicitly.
globalThis.chrome={
 storage:{local:{async get(k){return {[k]:structuredClone(db[k])};},async set(d){Object.assign(db,structuredClone(d));},async remove(k){delete db[k];}}},
 runtime:{id:'browser-test',getURL:p=>'chrome-extension://browser-test/'+p,getPlatformInfo:async()=>({get os(){return os;}}),getContexts:async()=>[{}],onMessage:event(),onStartup:event(),onInstalled:event(),
  sendNativeMessage:async()=>{nativeCalls++;throw Error('No native helper installed');},sendMessage:async msg=>({ok:true,data:msg.kind==='identity'?{userId:'_42_1'}:msg.kind==='enrollments'?{terms:[{id:'_58_1',name:course.term,duration:'从 2026年7月10日 至 2027年3月1日'}],courses:[course]}:msg.kind==='course'?{valid:true,pages:[{url:page,title:'--Labs'}],files:[],assignments:[],notes:[]}:msg.kind==='content'?{valid:true,pages:[],files,assignments:[{id:'_3_1',title:'Homework',url:detail,status:'unknown'}],notes:[]}:msg.kind==='detail'?{status:'unknown',due:'2026-10-01T15:59:00Z'}:[]})},
 tabs:{async create(){return{id:1};},async get(){return {status:'complete',url:ORIGIN+'/webapps/portal/execute/tabs/tabAction'};},async remove(){}},
 scripting:{executeScript:async()=>[{result:{label:'Fixture',settingsURL:ORIGIN+'/webapps/portal/execute/tabs/tabAction?tab_tab_group_id=_1_1&forwardUrl=edit_module%2F_3_1%2Fbbcourseorg%3Fcmd%3Dedit'}}]},
 permissions:{contains:async()=>true},alarms:{async get(k){return alarms.get(k)||{name:k};},async create(k,v){alarms.set(k,v);},async clear(k){alarms.delete(k);},onAlarm:event()},action:{onClicked:event()},downloads:{onChanged:event(),async download(options){
  downloadCalls++;assert.equal(options.saveAs,false);assert.equal(options.conflictAction,'uniquify');assert.match(options.filename,/^BBReader\/2026秋（Fall 2026）\/Course 2026 Fall\/Labs\/Lab 1\/file[12]\.pdf$/);
  const id=downloads.length;
  downloads.push({id,filename:'C:\\Users\\Fixture\\Downloads\\'+options.filename.replaceAll('/','\\'),url:options.url,finalUrl:options.url,state:'complete',danger:'safe',mime:'application/pdf',exists:true,fileSize:20,byExtensionId:'browser-test',startTime:new Date().toISOString()});return id;
 },async search(q){return downloads.filter(d=>q.id!==undefined?d.id===q.id:(!q.url||d.url===q.url)&&(!q.startedAfter||d.startTime>=q.startedAfter));},async cancel(id){const d=downloads.find(x=>x.id===id);if(d)d.state='interrupted';}}
};
globalThis.fetch=async (url,options)=>{const r=new Response(options?.method==='HEAD'?null:url.includes('calendarData')?'[]':'fixture',{headers:options?.method==='HEAD'?{'content-type':'application/pdf',etag:'v1'}:{'content-type':url.includes('calendarData')?'application/json':'text/html'}});Object.defineProperty(r,'url',{value:url});return r;};
await import('../extension/background.js');
const ask=msg=>new Promise(resolve=>chrome.runtime.onMessage.listeners[0](msg,{id:chrome.runtime.id,url:chrome.runtime.getURL('index.html')},resolve));
async function settle(fn){for(let i=0;i<1000;i++){if(fn())return;await new Promise(r=>setImmediate(r));}throw Error('Worker did not settle');}
async function tick(){chrome.alarms.onAlarm.listeners[0]({name:'download-next'});await new Promise(r=>setImmediate(r));}
test('Windows scan indexes only; explicit file batches download, resume safely and need no host',async()=>{
 const realNow=Date.now;Date.now=()=>Date.parse('2026-09-26T10:00:00+08:00');
 try{
  db.state={account:(await digest('Fixture')).slice(0,24),accountLabel:'Fixture',courses:[],assignments:[],files:{},warnings:[],enabled:true,integrationMode:'macos',credentialLogin:true,remindersEnabled:true};
  assert.equal((await ask({op:'state'})).state.integrationMode,'browser');
  const originalScript=chrome.scripting.executeScript;let portalAttempts=0;
  chrome.scripting.executeScript=async options=>{
    if(portalAttempts++===0)throw Error('Frame with ID 0 is showing error page');
    return originalScript(options);
  };
  await ask({op:'sync'});await settle(()=>db.state.job?.gradesQueued);
  chrome.scripting.executeScript=originalScript;
  assert.equal(portalAttempts,3,'a failed portal load recovers through SSO and retries discovery once');
  assert.equal(db.state.authStatus,'统一认证连接正常');
  chrome.alarms.onAlarm.listeners[0]({name:'resume-job'});await settle(()=>db.state.lastSync&&!db.state.job);
  assert.equal(Object.keys(db.state.files).length,2);assert.equal(downloadCalls,0,'index scans never download attachments');assert.equal(nativeCalls,0);
  const keys=Object.keys(db.state.files);
  const queued=await ask({op:'downloadFiles',keys});assert.equal(queued.ok,true);assert.equal(queued.queued,2);
  await settle(()=>downloadCalls===1);await tick();await settle(()=>downloadCalls===2&&Object.values(db.state.files).every(f=>f.browserDownload));
  const [first,second]=Object.values(db.state.files);
  assert.equal(first.browserDownload.id,0,'download ID zero must be persisted');
  assert.match(first.browserDownload.path,/^C:\\Users\\Fixture\\Downloads\\BBReader\\/);
  assert.equal((await ask({op:'completeAssignment',courseId:'_1_1',id:'_3_1',completed:true})).ok,true);
  assert.equal(db.state.assignments[0].localCompleted,true);assert.equal(db.state.assignments[0].status,'unknown');
  await ask({op:'downloadFiles',keys:[first.key]});await settle(()=>db.downloadQueue.batches.length===2&&db.downloadQueue.batches[1].status==='complete');
  assert.equal(downloadCalls,2,'explicitly rechecking an unchanged file reuses its browser download');
  assert.match(db.state.downloadStatus,/^已核对，复用已保存文件：/);
  downloads[0].exists=false;
  await ask({op:'downloadFiles',keys:[first.key]});await settle(()=>downloadCalls===3&&db.state.files[first.key].browserDownload.id===2);
  assert.equal(db.state.files[first.key].browserDownload.id,2,'explicit download fetches a missing file again');
  // Resume a download whose browser ID had not reached extension storage before worker shutdown.
  const recovered={...downloads[2],id:100,startTime:new Date(Date.now()+1).toISOString()};downloads.push(recovered);
  db.pending={restart:{mode:'browser',file:structuredClone(db.state.files[first.key]),headers:{etag:'v1'},account:db.state.account,run:db.state.lastSync,started:Date.now()}};
  downloads[2].startTime=new Date(Date.now()-1).toISOString();downloads[0].startTime=downloads[2].startTime;
  await tick();await settle(()=>!Object.keys(db.pending).length);
  assert.equal(db.state.files[first.key].browserDownload.id,100);assert.equal(downloadCalls,3);
  db.pending={bad:{mode:'browser',id:100,file:structuredClone(db.state.files[first.key]),account:db.state.account,run:db.state.lastSync,started:Date.now()}};recovered.mime='text/html';
  await tick();await settle(()=>!Object.keys(db.pending).length);assert.match(db.state.files[first.key].error,/HTML/);
  assert.equal((await ask({op:'integration',mode:'macos'})).ok,false);
  assert.equal((await ask({op:'chooseRoot'})).ok,false);assert.equal((await ask({op:'connectReminders'})).ok,false);
  const saved=await ask({op:'saveCredentials',username:'fixture',password:'fake-browser-password'});
  assert.equal(saved.ok,true,saved.error);assert.equal(nativeCalls,0,'browser vault never calls the macOS helper');
  assert.equal(db.state.browserCredentialLogin,true);assert.doesNotMatch(JSON.stringify(db),/fake-browser-password/,'password is not stored in plain text');
  assert.equal((await ask({op:'saveCredentials',username:'fixture',password:''})).ok,false);
  assert.equal((await ask({op:'deleteCredentials'})).ok,true);assert.equal(db.vault,undefined);assert.equal(db.state.browserCredentialLogin,false);assert.equal(nativeCalls,0);
  const originalAccount=db.state.account,originalMessages=chrome.runtime.sendMessage;
  chrome.runtime.sendMessage=async msg=>msg.kind==='identity'?{ok:true,data:{userId:'_99_1'}}:originalMessages(msg);
  await ask({op:'sync'});await settle(()=>db.state.lastError?.includes('不同 Blackboard 账户'));
  assert.equal(db.state.account,originalAccount);assert.equal(db.state.assignments.length,1);
  chrome.runtime.sendMessage=originalMessages;
  os='mac';delete db.state.integrationMode;
  assert.equal((await ask({op:'state'})).state.integrationMode,'macos','existing macOS configuration is retained');
  db.state={courses:[],assignments:[],files:{},warnings:[]};
  assert.equal((await ask({op:'state'})).state.integrationMode,'browser','new macOS installation is standalone by default');
  chrome.runtime.sendNativeMessage=async()=>({ok:true,root:'/existing/archive',courses:{}});
  assert.equal((await ask({op:'integration',mode:'macos'})).ok,true);
  assert.equal((await ask({op:'state'})).state.integrationMode,'macos');
  await ask({op:'settings',enabled:true,selected:[]});
  assert.equal((await ask({op:'state'})).state.integrationMode,'macos','unrelated settings preserve the selected mode');
  assert.equal((await ask({op:'integration',mode:'browser'})).ok,true);
  assert.equal((await ask({op:'state'})).state.integrationMode,'browser');
 }finally{Date.now=realNow;globalThis.setTimeout=realTimeout;}
});

test('course opt-in survives scans, preserves other indexes and respects pause, cancellation and ignore',async()=>{
 const oldParse=chrome.runtime.sendMessage,realNow=Date.now;
 let now=Date.parse('2026-09-28T10:00:00+08:00');Date.now=()=>now;
 const other={...course,id:'_2_1',name:'Other course',code:'CS200-2026FA',url:course.url.replace('_1_1','_2_1')};
 chrome.runtime.sendMessage=async msg=>{
  const r=await oldParse(msg);
  if(msg.kind==='enrollments')r.data.courses=[course,other];
  if(msg.kind==='course'&&msg.url.includes('id=_2_1'))r.data.pages=[{url:page.replace('_1_1','_2_1'),title:'--Labs'}];
  return r;
 };
 const scan=async()=>{
  now+=1000;await ask({op:'sync'});await settle(()=>db.state.job?.gradesQueued);
  chrome.alarms.onAlarm.listeners[0]({name:'resume-job'});
  await settle(()=>!db.state.job&&db.state.lastRun===now);
  for(let i=0;i<30;i++)await new Promise(r=>setImmediate(r));
 };
 try{
  os='win';db.state={account:(await digest('Fixture')).slice(0,24),accountLabel:'Fixture',courses:[],files:{},assignments:[],warnings:[],enabled:true,integrationMode:'browser'};
  db.downloadQueue={stopped:false,generation:0,items:[],batches:[]};db.pending={};
  const before=downloadCalls;
  await scan();assert.equal(Object.keys(db.state.files).length,4);assert.equal(downloadCalls,before);
  const selected=[course.id,other.id];
  assert.equal((await ask({op:'settings',enabled:true,selected,autoDownload:['missing']})).ok,false);
  assert.equal((await ask({op:'settings',enabled:true,selected,autoDownload:[course.id]})).ok,true);
  await ask({op:'settings',enabled:true,selected,checkTime:'10:30'});
  assert.equal(db.state.courses[0].autoDownload,true,'schedule updates preserve the course setting');
  await scan();await settle(()=>db.downloadQueue.items[0]?.status==='complete');
  assert.equal(db.state.courses[0].autoDownload,true,'rediscovery preserves opt-in');
  assert.equal(db.state.courses[1].autoDownload,false);
  assert.equal(downloadCalls,before+1);assert.equal(db.downloadQueue.items.length,2);
  assert.ok(db.downloadQueue.items.every(i=>i.key.startsWith('_1_1:')));
  assert.ok(Object.values(db.state.files).filter(f=>f.courseId===other.id).every(f=>!f.browserDownload),'other course files remain indexed without downloads');
  const batch=db.downloadQueue.batches[0].id;
  assert.equal((await ask({op:'stopDownloads'})).ok,true);
  await scan();assert.equal(downloadCalls,before+1,'scanning does not undo pause');
  assert.equal((await ask({op:'cancelDownloads',batchId:batch})).ok,true);
  const first='_1_1:991_1',second='_1_1:992_1';
  await ask({op:'downloadFiles',keys:[first]});
  assert.equal((await ask({op:'ignoreFiles',keys:[first],ignored:true})).ok,true);
  await scan();assert.equal(downloadCalls,before+1,'ignored and terminally cancelled files stay out of automatic batches');
  assert.equal(db.state.files[first].ignored,true);assert.ok(db.state.files[second]);
  assert.equal((await ask({op:'settings',enabled:true,selected,autoDownload:[]})).ok,true);
  await scan();assert.equal(db.state.courses[0].autoDownload,false);assert.equal(Object.keys(db.state.files).length,4);
 } finally {chrome.runtime.sendMessage=oldParse;Date.now=realNow;}
});
test('stop during download creation cancels the returned ID and keeps later files out of the queue',async()=>{
 const account=(await digest('Fixture')).slice(0,24),key='_1_1:stop';
 db.state={account,integrationMode:'browser',courses:[{id:'_1_1',enabled:true}],files:{[key]:{key,id:'stop',name:'stop.pdf',courseId:'_1_1',url:ORIGIN+'/bbcswebdav/xid-stop',relative:['Term','Course','stop.pdf']}},warnings:[],lastSync:1};
 db.downloadQueue={stopped:false,generation:0,items:[],batches:[]};delete db.pending;
 let resolveDownload;
 chrome.downloads.download=()=>new Promise(resolve=>{resolveDownload=()=>{downloads.push({id:40,url:ORIGIN+'/bbcswebdav/xid-stop',filename:'C:\\Fixture\\stop.pdf',state:'in_progress',byExtensionId:'browser-test',startTime:new Date().toISOString()});resolve(40);};});
 const adding=ask({op:'downloadFiles',keys:[key]});await settle(()=>Object.keys(db.pending||{}).length===1);
 assert.equal((await ask({op:'stopDownloads'})).ok,true);resolveDownload();await adding;await settle(()=>!Object.keys(db.pending||{}).length);
 assert.equal(downloads.find(d=>d.id===40).state,'interrupted');
 assert.equal(db.downloadQueue.stopped,true);assert.equal(db.downloadQueue.items[0].status,'cancelled');
 assert.equal((await ask({op:'state'})).downloadQueue.items.length,1,'no files outside the selected batch are introduced');
});

test('a full cancel removes aborted downloads where resume only requeues them',async()=>{
 const account=(await digest('Fixture')).slice(0,24),key='_1_1:full-cancel';
 db.state={account,integrationMode:'browser',courses:[{id:'_1_1',enabled:true}],files:{[key]:{key,id:'full-cancel',name:'cancel.pdf',courseId:'_1_1',url:ORIGIN+'/bbcswebdav/xid-full-cancel',relative:['Term','Course','cancel.pdf']}},warnings:[],lastSync:1};
 const oldDownload=chrome.downloads.download,oldCancel=chrome.downloads.cancel;
 let cancelledIds=[];
 chrome.downloads.download=async()=>{downloads.push({id:42,url:ORIGIN+'/bbcswebdav/xid-full-cancel',filename:'C:\\Fixture\\cancel.pdf',state:'in_progress',byExtensionId:'browser-test',startTime:new Date().toISOString()});return 42;};
 chrome.downloads.cancel=async id=>{cancelledIds.push(id);};
 try {
  db.downloadQueue={stopped:false,generation:0,items:[],batches:[]};delete db.pending;
  await ask({op:'downloadFiles',keys:[key]});await settle(()=>Object.keys(db.pending||{}).length===1);
  const batchId=(await ask({op:'state'})).downloadQueue.batches[0].id;
  // Abort first: the in-flight file is revoked, then settles as cancelled, so resume is possible.
  assert.equal((await ask({op:'stopDownloads'})).ok,true);
  assert.deepEqual(cancelledIds,[42],'the abort reaches the browser download');
  downloads.find(d=>d.id===42).state='interrupted';
  chrome.downloads.onChanged.listeners[0]({id:42,state:{current:'interrupted'}});
  await settle(()=>db.downloadQueue.items[0]?.status==='cancelled'&&!Object.keys(db.pending||{}).length);
  assert.equal((await ask({op:'state'})).downloadQueue.items.length,1,'an aborted download is still in the queue, so resume stays available');
  // Now cancel for good: the item leaves the queue and the revoked download is discarded.
  const result=await ask({op:'cancelDownloads',batchId});
  assert.equal(result.ok,true);assert.equal(result.cancelled,1);
  assert.equal(db.downloadQueue.items.some(i=>i.key===key),false,'a cancelled download is not offered again');
  assert.equal(db.downloadQueue.batches[0].status,'cancelled');
  assert.equal(db.state.files[key].browserDownload,undefined,'an aborted download is not recorded as saved');
  assert.equal((await ask({op:'cancelDownloads',batchId})).ok,false,'cancelling twice is refused instead of reviving the batch');
  assert.equal(db.downloadQueue.batches[0].status,'cancelled');
  assert.equal((await ask({op:'resumeDownloads',batchId})).ok,false,'a full cancel cannot be resumed');
  // A later queue is not blocked by the removed items. browser-mode replay matching keys on
  // url + start time, so this stub is removed once it has served the abort above; otherwise its
  // fixture record (same url, same millisecond) would make the match ambiguous.
  const waitingDownload=chrome.downloads.download;
  chrome.downloads.download=async()=>{downloads.push({id:44,url:ORIGIN+'/bbcswebdav/xid-full-cancel-9',filename:'C:\\Fixture\\cancel2.pdf',state:'complete',danger:'safe',mime:'application/pdf',fileSize:20,byExtensionId:'browser-test',startTime:new Date().toISOString()});return 44;};
  const freshKey='_1_1:full-cancel-2';
  db.state.files[freshKey]={key:freshKey,id:'full-cancel-2',name:'cancel2.pdf',courseId:'_1_1',url:ORIGIN+'/bbcswebdav/xid-full-cancel-9',relative:['Term','Course','cancel2.pdf']};
  delete db.pending;
  const second=await ask({op:'downloadFiles',keys:[freshKey]});
  assert.equal(second.ok,true);
  await settle(()=>db.state.files[freshKey].browserDownload&&!Object.keys(db.pending||{}).length);
  chrome.downloads.download=waitingDownload;
  assert.equal((await ask({op:'state'})).downloadQueue.batches.length,2);
  assert.equal((await ask({op:'state'})).downloadQueue.items.length,1,'only the fresh batch is queued');
 } finally {chrome.downloads.download=oldDownload;chrome.downloads.cancel=oldCancel;}
});

test('stop stays pending until an active browser download reaches a terminal state',async()=>{
 const account=(await digest('Fixture')).slice(0,24),key='_1_1:active-stop';
 db.state={account,integrationMode:'browser',courses:[{id:'_1_1',enabled:true}],files:{[key]:{key,id:'active-stop',name:'active-stop.pdf',courseId:'_1_1',url:ORIGIN+'/bbcswebdav/xid-active-stop',relative:['Term','Course','active-stop.pdf']}},warnings:[],lastSync:1};
 db.downloadQueue={stopped:false,generation:0,items:[],batches:[]};delete db.pending;
 const oldDownload=chrome.downloads.download,oldCancel=chrome.downloads.cancel;
 chrome.downloads.download=async()=>{downloads.push({id:41,url:ORIGIN+'/bbcswebdav/xid-active-stop',filename:'C:\\Fixture\\active-stop.pdf',state:'in_progress',byExtensionId:'browser-test',startTime:new Date().toISOString()});return 41;};
 chrome.downloads.cancel=async()=>{}; // Simulate a browser that has not reported cancellation yet.
 try {
   const adding=ask({op:'downloadFiles',keys:[key]});await settle(()=>Object.keys(db.pending||{}).length===1);
   await adding;const result=await ask({op:'stopDownloads'});
   assert.equal(result.stopping,true);assert.equal(db.downloadQueue.stopping,true);
   downloads.find(d=>d.id===41).state='interrupted';await tick();await settle(()=>!Object.keys(db.pending||{}).length);
   assert.equal(db.downloadQueue.stopping,false);assert.equal(db.downloadQueue.items[0].status,'cancelled');
 } finally {chrome.downloads.download=oldDownload;chrome.downloads.cancel=oldCancel;}
});

function queueFixture(key) {
 os='win';
 db.state={account:'queue-fixture',integrationMode:'browser',courses:[{id:'_1_1',enabled:true}],files:{[key]:{key,id:key,name:'fixture.pdf',courseId:'_1_1',url:ORIGIN+'/bbcswebdav/'+key,relative:['Term','Course','fixture.pdf']}},warnings:[],lastSync:1};
 db.pending={};db.downloadQueue={stopped:false,generation:0,items:[],batches:[]};
}
test('ignore changes wait for downloads to finish, then survive a later download request',async()=>{
 const key='_1_1:ignore-race';queueFixture(key);
 const originalFetch=fetch,originalDownload=chrome.downloads.download;
 let release;
 globalThis.fetch=(url,options)=>new Promise(resolve=>{release=()=>resolve(originalFetch(url,options));});
 chrome.downloads.download=async()=>{throw Error('fixture download failure');};
 try {
  const task=ask({op:'downloadFiles',keys:[key]});await settle(()=>!!release);
  const rejected=await ask({op:'ignoreFiles',keys:[key],ignored:true});
  assert.equal(rejected.ok,false);assert.match(rejected.error,/暂停下载/);
  release();await task;
  assert.equal((await ask({op:'ignoreFiles',keys:[key],ignored:true})).ok,true);
  assert.equal((await ask({op:'downloadFiles',keys:[key]})).ok,false);
  assert.equal(db.state.files[key].ignored,true);
 } finally {globalThis.fetch=originalFetch;chrome.downloads.download=originalDownload;}
});
test('cancelling an old batch preserves a newer active download of the same file',async()=>{
 const key='_1_1:batch-isolation';queueFixture(key);
 const oldCancel=chrome.downloads.cancel;const cancelled=[];chrome.downloads.cancel=async id=>cancelled.push(id);
 try {
  db.downloadQueue={stopped:false,generation:8,batches:[{id:'old',status:'complete'},{id:'new',status:'running'}],items:[{key,batchId:'old',status:'cancelled'},{key,batchId:'new',status:'running'}]};
  db.pending={current:{id:800,batchId:'new',file:db.state.files[key]}};
  assert.equal((await ask({op:'cancelDownloads',batchId:'old'})).ok,true);
  assert.deepEqual(db.downloadQueue.items,[{key,batchId:'new',status:'running'}]);
  assert.equal(db.downloadQueue.generation,8,'single-batch cancel must not invalidate another batch');
  assert.equal(db.pending.current.cancelRequested,undefined);assert.deepEqual(cancelled,[]);
 } finally {chrome.downloads.cancel=oldCancel;db.pending={};}
});
test('a running item without a pending download is recovered exactly once after worker restart',async()=>{
 const key='_1_1:orphan';queueFixture(key);let calls=0;
 const oldDownload=chrome.downloads.download;
 db.downloadQueue.batches=[{id:'restart',account:db.state.account,mode:'browser',status:'running'}];
 db.downloadQueue.items=[{key,batchId:'restart',status:'running'}];
 chrome.downloads.download=async()=>{calls++;downloads.push({id:801,url:db.state.files[key].url,filename:'C:\\Fixture\\recovered.pdf',state:'complete',danger:'safe',mime:'application/pdf',fileSize:20});return 801;};
 try {
  await tick();await settle(()=>db.downloadQueue.items[0].status==='complete');
  assert.equal(db.state.files[key].browserDownload.id,801);
  await tick();assert.equal(calls,1);
  db.downloadQueue.stopped=true;db.downloadQueue.stopping=true;db.downloadQueue.items[0].status='running';
  await tick();await settle(()=>!db.downloadQueue.stopping);
  assert.equal(db.downloadQueue.items[0].status,'cancelled');assert.equal(calls,1,'paused recovery must not start a download');
 } finally {chrome.downloads.download=oldDownload;}
});
test('cancel during download creation cancels the late ID and keeps the batch terminal',async()=>{
 const key='_1_1:late-cancel';queueFixture(key);
 const oldDownload=chrome.downloads.download;let release;
 chrome.downloads.download=()=>new Promise(resolve=>{release=()=>{downloads.push({id:802,url:db.state.files[key].url,filename:'C:\\Fixture\\late.pdf',state:'in_progress'});resolve(802);};});
 try {
  const task=ask({op:'downloadFiles',keys:[key]});await settle(()=>!!release);
  const batchId=db.downloadQueue.batches[0].id;
  assert.equal((await ask({op:'cancelDownloads',batchId})).ok,true);
  release();await task;await settle(()=>!Object.keys(db.pending).length);
  assert.equal(downloads.find(d=>d.id===802).state,'interrupted');
  assert.equal(db.downloadQueue.batches[0].status,'cancelled');
  assert.equal(db.downloadQueue.items.length,0);
  assert.equal((await ask({op:'resumeDownloads',batchId})).ok,false);
 } finally {chrome.downloads.download=oldDownload;}
});

test('optional native permission reloads once and enables integration only after host verification',async()=>{
 const oldNative=chrome.runtime.sendNativeMessage,oldContains=chrome.permissions.contains,oldCreate=chrome.tabs.create;
 const opened=[];os='mac';db.pending={};db.state={integrationMode:'browser',courses:[],files:{},assignments:[],warnings:[]};
 chrome.tabs.create=async tab=>{opened.push(tab.url);return{id:99};};
 try{
  delete chrome.runtime.sendNativeMessage;
  chrome.permissions.contains=async()=>false;
  assert.equal((await ask({op:'integration',mode:'macos'})).ok,false);
  assert.equal(db.integrationReload,undefined,'no reload without permission');
  chrome.permissions.contains=async()=>true;
  const r=await ask({op:'integration',mode:'macos'});
  assert.equal(r.reloadRequired,true);assert.equal(db.integrationReload,true);
  assert.equal(db.state.integrationMode,'browser','do not claim the helper works yet');
  chrome.runtime.sendNativeMessage=async(host,msg)=>{assert.equal(host,'cn.sustech.bbreader');assert.deepEqual(msg,{op:'status'});return{ok:true};};
  chrome.runtime.onInstalled.listeners[0]({reason:'update'});
  await settle(()=>opened.length===1);
  assert.equal(db.integrationReload,undefined);assert.equal(db.state.integrationMode,'macos');
  assert.equal(opened[0],'index.html#/settings');
  db.state.integrationMode='browser';db.integrationReload=true;
  delete chrome.runtime.sendNativeMessage;
  chrome.runtime.onInstalled.listeners[0]({reason:'update'});
  await settle(()=>opened.length===2);
  assert.equal(db.integrationReload,undefined,'failed recovery cannot loop');
  assert.equal(db.state.integrationMode,'browser');assert.match(db.state.integrationError,/重新加载/);
 }finally{chrome.runtime.sendNativeMessage=oldNative;chrome.permissions.contains=oldContains;chrome.tabs.create=oldCreate;}
});
