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
  await ask({op:'sync'});await settle(()=>db.state.job?.gradesQueued);
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
