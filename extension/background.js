import {courseSettingsURL,selectCurrentCourses} from './courses.js';
import {CAS_PERMISSION,SSO,renewLogin} from './auth.js';
import {saveVault,readVault,deleteVault,validCredentials} from './vault.js';
import { ORIGIN, PORTAL, DAY, campusDay, dailyDue, nextCheck, checkTime, cleanName, sameAccountLabel, browserFilename, readURL, bbURL, digest, calendarDate, attachmentName } from './core.js';
const HOST = 'cn.sustech.bbreader', DAILY = 'daily-nine', RESUME = 'resume-job';
let running = false, creatingParser, syncingReminders=false, activeDownloadCheck;
const platform = chrome.runtime.getPlatformInfo();
const get = async () => {
  const s=(await chrome.storage.local.get('state')).state || {courses:[],assignments:[],files:{},status:'尚未连接',warnings:[],enabled:true};
  const legacy=s.credentialLogin||s.remindersEnabled||Object.values(s.files).some(f=>f.savedPath&&f.sha256);
  s.integrationMode=(await platform).os==='mac'?(s.integrationMode||(legacy?'macos':'browser')):'browser';
  return s;
};
const put = state => chrome.storage.local.set({state});
async function native(message) {
  if((await platform).os!=='mac')throw new Error('系统集成仅支持 macOS');
  const r = await chrome.runtime.sendNativeMessage(HOST, message);
  if (!r?.ok) throw new Error(r?.error || '本地助手未响应'); return r;
}
// Credentials come from the Keychain helper on macOS integration, otherwise from the encrypted browser vault.
const readCredentials=async()=>(await get()).integrationMode==='macos'?native({op:'readCredentials'}):readVault();
const renew=(options={})=>renewLogin({native,get,put,readCredentials,...options});
async function parse(html, url, kind) {
  if (!(await chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']})).length) {
    creatingParser ||= chrome.offscreen.createDocument({url:'offscreen.html',reasons:['DOM_PARSER'],justification:'解析 Blackboard 课程和作业的 HTML，不执行网页脚本'}).finally(() => creatingParser = null);
    await creatingParser;
  }
  const r = await chrome.runtime.sendMessage({target:'parser',html,url,kind});
  if (!r?.ok) throw new Error(r?.error || '页面解析失败'); return r.data;
}
async function request(url, method = 'GET', signal) {
  const timeout=AbortSignal.timeout(20000),combined=signal?AbortSignal.any([signal,timeout]):timeout;
  const r = await fetch(readURL(url), {method, credentials:'include', cache:'no-cache', signal:combined});
  if (r.status === 401 || r.status === 403 || !bbURL(r.url) || /\/login|\/cas\//.test(r.url)) throw new Error('需要重新登录 Blackboard');
  if (!r.ok) throw new Error(`Blackboard 返回 ${r.status}`); return r;
}
// Only the complete enrollment settings page is used; display checkboxes are ignored.
async function discover(retry = true) {
  const tab = await chrome.tabs.create({url:PORTAL,active:false});
  try {
    const deadline = Date.now() + 25000;
    while ((await chrome.tabs.get(tab.id)).status !== 'complete') {
      if (Date.now() > deadline) throw new Error('课程门户加载超时');
      await new Promise(r => setTimeout(r, 300));
    }
    const current=await chrome.tabs.get(tab.id);
    if(!current.url?.startsWith(ORIGIN+'/'))throw new Error('需要重新登录 Blackboard');
    const [{result}] = await chrome.scripting.executeScript({target:{tabId:tab.id},func:async () => {
      for (let i=0;i<30;i++) {
        const label = [...(document.querySelector('#global-nav-link')?.childNodes || [])].filter(n=>n.nodeType===3).map(n=>n.textContent).join(' ').replace(/\s+/g,' ').trim();
        const settings=[...document.querySelectorAll('a[href]')].find(a=>{
          try{return /^edit_module\/_\d+_\d+\/bbcourseorg\?cmd=edit$/.test(new URL(a.href).searchParams.get('forwardUrl')||'');}catch{return false;}
        });
        if(label&&settings)return {label,person:document.title.replace(/^(?:欢迎[，,]|Welcome,)\s*/,'').replace(/\s*[–-]\s*Blackboard Learn$/,''),settingsURL:settings.href};
        if (document.querySelector('input[type=password]')) return {error:'需要重新登录 Blackboard'};
        await new Promise(r => setTimeout(r,500));
      }
      return {error:'未找到完整课程列表入口，请确认已登录 Blackboard。'};
    }});
    if (!result || result.error) throw new Error(result?.error || '无法读取课程门户');
    const settingsURL=courseSettingsURL(result.settingsURL);
    const response=await fetch(settingsURL,{credentials:'include',cache:'no-cache',signal:AbortSignal.timeout(20000)});
    if(response.status===401||response.status===403||!bbURL(response.url)||/\/login|\/cas\//.test(response.url))throw new Error('需要重新登录 Blackboard');
    if(!response.ok)throw new Error(`完整课程列表读取失败：${response.status}`);
    const enrollment=await parse(await response.text(),response.url,'enrollments');
    const profile=await request(ORIGIN+'/webapps/blackboard/execute/personalInfo');
    const identity=await parse(await profile.text(),profile.url,'identity');
    return {label:result.label,person:result.person,...identity,...selectCurrentCourses(enrollment)};
  } catch(e) {
    if(retry&&/重新登录/.test(e.message)){await renew();return discover(false);}
    throw e;
  } finally { await chrome.tabs.remove(tab.id).catch(()=>{}); }
}
async function arm() { await chrome.alarms.create(DAILY,{when:nextCheck(Date.now(),(await get()).checkTime)}); }
async function start(automatic = false) {
  if (running || downloading || reconciling || syncingReminders) return;
  running = true;
  let s = await get();
  if (s.job) {running=false;return pump();}
  if (automatic && (!s.enabled || !s.account || !dailyDue(s.lastAutoDay,Date.now(),s.checkTime))) {running=false;return;}
  // Mark the attempt, not just success: login failure must not cause repeated daily scraping.
  if (automatic) s.lastAutoDay = campusDay();
  s.status = '正在读取课程…'; s.warnings = []; await put(s);
  try {
    const found = await discover(), identity = (await digest(ORIGIN+':'+found.userId)).slice(0,24);
    s=await get();
    if (s.account && (s.accountIdentity?s.accountIdentity!==identity:!sameAccountLabel(s.accountLabel,found.label,found.person))) {
      throw new Error('检测到不同 Blackboard 账户。请先在设置中清空本地索引，再连接该账户。已有文件不会删除。');
    }
    s.account ||= identity;s.accountIdentity=identity;s.accountLabel = found.label;s.currentTerm=found.term;
    s.courses = found.courses.map(c=>({...c,enabled:s.courses.find(old=>old.id===c.id)?.enabled !== false}));
    const chosen = s.courses.filter(c=>c.enabled);
    s.job = {queue:chosen.map(c=>({kind:'course',courseId:c.id,url:c.url,path:[]})),seen:chosen.map(c=>`course:${c.url}`),done:0,started:Date.now()};
    s.status = `准备检查 ${chosen.length} 门课程`; await put(s);
  } catch (e) { s=await get();s.status = e.message; s.lastError = e.message; await put(s); }
  finally { running = false; await arm(); }
  if (s.job) await pump();
}
async function calendar(s) {
  const r = await request(`${ORIGIN}/webapps/calendar/calendarData/calendars`);
  if (!(r.headers.get('content-type') || '').includes('json')) throw new Error('日历接口未返回 JSON');
  const raw = await r.json(), list = Array.isArray(raw) ? raw : raw.calendars;
  if (!Array.isArray(list)) throw new Error('日历集合格式尚不支持，作业仍从详情页读取');
  const ids = list.map(c=>c.id).filter(x=>typeof x==='string');
  if (!ids.length) return;
  const url = new URL(`${ORIGIN}/webapps/calendar/calendarData/events`);
  url.search = new URLSearchParams({start:String(Date.now()-30*DAY),end:String(Date.now()+120*DAY),course_id:'',calendarIds:ids.join(',')});
  const events = await (await request(url.href)).json();
  if (!Array.isArray(events)) throw new Error('日历事件格式尚不支持');
  // Only enrich already-discovered assignments; never infer submission state from calendar visibility.
  for (const a of s.assignments) {
    const c = s.courses.find(c=>c.id===a.courseId);
    const matches = events.filter(e => e.title===a.title && (e.courseId===a.courseId || e.calendarName===c?.name));
    if (matches.length===1 && !a.due) { a.due = calendarDate(matches[0].originalStart || matches[0].start); a.dueSource='calendar'; }
  }
}
async function step(task, s) {
  const c = s.courses.find(c=>c.id===task.courseId);
  const r = await request(task.url), html = await r.text();
  const parsed = await parse(html, r.url, task.kind);
  const add = t => {
    const key = `${t.kind}:${t.url}`;
    if (!s.job.seen.includes(key)) { s.job.seen.push(key); s.job.queue.push(t); }
  };
  if (task.kind==='detail') {
    const a = s.assignments.find(a=>a.courseId===c.id && a.id===task.id);
    Object.assign(a,parsed,{checked:Date.now(),dueSource:'detail'}); return;
  }
  if (task.kind==='grades') {
    for (const a of s.assignments.filter(a=>a.courseId===c.id)) {
      const rows = parsed.filter(r=>r.title===a.title);
      if(rows.length===1 && rows[0].status!=='unknown') a.status=rows[0].status;
    } return;
  }
  if (!parsed.valid) throw new Error('页面不是可识别的课程内容，已保留旧数据');
  for (const p of parsed.pages) add({kind:'content',url:p.url,courseId:c.id,path:[...task.path,cleanName(p.title)],depth:(task.depth||0)+1});
  for (const a of parsed.assignments) {
    const old = s.assignments.find(x=>x.courseId===c.id && x.id===a.id);
    const fresh = {...a,courseId:c.id,courseName:c.name,seen:s.job.started};
    if(old){fresh.due=old.due;fresh.status=old.status;fresh.checked=old.checked;}
    if (old) Object.assign(old,fresh); else s.assignments.push(fresh);
    add({kind:'detail',url:a.url,courseId:c.id,id:a.id});
  }
  for (const f of parsed.files) {
    const key = `${c.id}:${f.id}`, old = s.files[key];
    s.files[key] = {...old,...f,key,courseId:c.id,relative:[cleanName(c.term),cleanName(c.name),...task.path,...(f.itemFolder?[cleanName(f.itemFolder)]:[]),cleanName(old?.archiveName || f.name)],seen:s.job.started};
  }
  if (parsed.notes.length) {
    s.notes ||= {}; s.notes[task.url]={courseId:c.id,path:task.path,items:parsed.notes};
  }
}
async function pump() {
  if (running) return;
  running = true;
  let s = await get();
  if(s.job)await chrome.alarms.create(RESUME,{when:Date.now()+60000});
  const until = Date.now()+18000;
  try {
    while (s.job?.queue.length && Date.now()<until) {
      const task = s.job.queue[0];
      s.status = `正在检查 ${s.courses.find(c=>c.id===task.courseId)?.name || ''} · ${s.job.done} 页`;
      try {
        if ((task.depth||0)>15 || s.job.done>1500) throw new Error('内容层数或页面数量超过限制，请缩小选课范围');
        await step(task,s);
      } catch (e) {
        if (/重新登录|different/i.test(e.message)) throw e;
        s.warnings.push(`${s.courses.find(c=>c.id===task.courseId)?.name}: ${e.message}`);
      }
      s.job.queue.shift(); s.job.done++; await put(s);
    }
    if (s.job && !s.job.queue.length) {
      if (!s.job.gradesQueued) {
        s.job.gradesQueued = true;
        s.job.queue = s.courses.filter(c=>c.enabled).map(c=>({kind:'grades',courseId:c.id,url:`${ORIGIN}/webapps/bb-mygrades-BBLEARN/myGrades?course_id=${c.id}&stream_name=mygrades&is_stream=false`}));
      } else {
        try { await calendar(s); } catch(e) { s.warnings.push(`日历补充：${e.message}`); }
        s.lastRun = s.job.started; s.lastSync = Date.now(); s.lastError=null; s.job=null;
        s.status = s.warnings.length ? '检查完成，部分内容需核对' : '课程和作业检查完成';
      }
      await put(s);
    }
  } catch (e) { s.status=e.message; s.lastError=e.message; s.job=null; await put(s); }
  finally { running=false; }
  if (s.job) await chrome.alarms.create(RESUME,{when:Date.now()+30000});
  else if (s.lastSync && !s.lastError) {
    if(s.integrationMode==='macos'&&s.remindersEnabled)await syncReminders().catch(()=>{});
  }
}
let downloading = false, downloadTimer;
const downloadState=async()=>((await chrome.storage.local.get('downloadQueue')).downloadQueue)||{stopped:false,generation:0,items:[],batches:[]};
const putDownloadState=value=>chrome.storage.local.set({downloadQueue:value});
async function runDirectoryMigration(journal){
  const helper=await native({op:'status'});if(!helper.capabilities?.includes('confirmed-directory-migration')||!helper.capabilities?.includes('migration-journal'))throw new Error('请先更新 macOS 本地助手后再迁移文件');
  await native({op:'migrationJournal',action:'save',planId:journal.id,record:journal});
  const scope=journal.scope,courseId=journal.courseId;
  for(const item of (journal.migrate?journal.files:[])){
    if(item.status==='complete'||item.status==='failed')continue;
    try{
      const relative=journal.migrate?(scope==='course'?item.relative.slice(2):item.relative):item.relative;
      const result=await native({op:'relocate',courseId:item.courseId,sourcePath:item.sourcePath,relative:item.relative,targetRelative:relative,destinationRoot:journal.path,sha256:item.sha256});
      if(!result.moved)throw new Error(result.preserved?'文件内容与索引不一致，保留原文件':'找不到原文件，保留原位置');
      item.status='complete';item.path=result.path;item.relative=result.relative||relative;
    }catch(e){item.status='failed';item.error=e.message;}
    await chrome.storage.local.set({directoryMigration:journal});
    await native({op:'migrationJournal',action:'save',planId:journal.id,record:journal});
  }
  const config=await native(scope==='course'?{op:'setCourse',courseId,path:journal.path}:{op:'setRoot',path:journal.path});
  const s=await get();
  for(const item of journal.files){
    const f=s.files[item.key];if(!f)continue;
    if(journal.migrate&&item.status==='complete'){f.savedPath=item.path;f.savedRelative=item.relative;f.relative=item.relative;}
  }
  await put(s);
  const failed=journal.files.filter(f=>f.status==='failed').length;
  if(failed){journal.committed=true;await chrome.storage.local.set({directoryMigration:journal});await native({op:'migrationJournal',action:'save',planId:journal.id,record:journal});}else{await native({op:'migrationJournal',action:'finish',planId:journal.id});await chrome.storage.local.remove('directoryMigration');}
  return {...config,migrated:journal.files.filter(f=>f.status==='complete').length,failed};
}
async function queueDownloads(keys) {
  const s=await get(),q=await downloadState();
  if(s.job||running)throw new Error('课程检查完成后才能下载');
  if(Object.keys((await chrome.storage.local.get('pending')).pending||{}).length)throw new Error('请等待已中止的下载收尾后再开始新任务');
  if(!Array.isArray(keys)||!keys.length)throw new Error('请先选择要下载的课件');
  const unique=[...new Set(keys)];
  if(unique.length>5000)throw new Error('单次最多选择 5000 个文件，请分批下载');
  const files=unique.map(key=>s.files[key]);
  if(files.some(f=>!f||!s.courses.some(c=>c.id===f.courseId&&c.enabled)))throw new Error('所选课件已不存在或所属课程未启用，请刷新列表后重试');
  const batchId=crypto.randomUUID(),batch={id:batchId,account:s.account,mode:s.integrationMode||'browser',created:Date.now(),keys:unique,status:'queued'};
  const existing=new Set(q.items.filter(i=>['queued','running'].includes(i.status)).map(i=>i.key));
  const additions=unique.filter(key=>!existing.has(key)).map(key=>({key,batchId,status:'queued'}));
  batch.keys=additions.map(i=>i.key);
  if(!batch.keys.length)throw new Error('所选课件已在下载队列中');
  q.batches.push(batch);q.items.push(...additions);q.stopped=false;
  await putDownloadState(q);await downloadBatch();
  return {ok:true,batchId,queued:batch.keys.length};
}
async function stopDownloads() {
  const q=await downloadState(),active=q.items.filter(i=>['queued','running'].includes(i.status));
  if(!active.length)return {ok:true,stopped:q.stopped,stopping:!!q.stopping};
  q.stopped=true;q.stopping=true;q.generation++;
  for(const item of active)if(item.status==='queued')item.status='cancelled';
  await putDownloadState(q);clearTimeout(downloadTimer);activeDownloadCheck?.abort();await chrome.alarms.clear('download-next');
  const p=(await chrome.storage.local.get('pending')).pending||{};
  const pendingKeys=new Set(Object.values(p).map(job=>job.file?.key));
  for(const [token,job] of Object.entries(p)) {
    const item=q.items.find(i=>i.key===job.file?.key&&i.status==='running');
    if(!item)continue;
    job.cancelRequested=true;p[token]=job;
    if(job.id!==undefined)await chrome.downloads.cancel(job.id).catch(()=>{});
  }
  for(const item of q.items)if(item.status==='running'&&!pendingKeys.has(item.key))item.status='cancelled';
  await putDownloadState(q);
  await chrome.storage.local.set({pending:p});
  if(Object.keys(p).length) {
    await chrome.alarms.create('download-next',{when:Date.now()+1000});
    await reconcileDownloads();
  } else {
    q.stopping=false;
    await putDownloadState(q);
  }
  const latest=await downloadState();
  return {ok:true,stopped:true,stopping:!!latest.stopping};
}
async function resumeDownloads(batchId) {
  const q=await downloadState(),batch=q.batches.find(b=>b.id===batchId);
  if(!batch)throw new Error('下载批次不存在，请重新选择课件');
  if(batch.account!==(await get()).account)throw new Error('账户已改变，请重新选择课件');
  if(downloading||q.items.some(i=>['queued','running'].includes(i.status)))throw new Error('请等待当前下载批次结束后再恢复');
  if(Object.keys((await chrome.storage.local.get('pending')).pending||{}).length)throw new Error('请等待当前下载收尾');
  for(const item of q.items)if(item.batchId===batchId&&item.status==='cancelled')item.status='queued';
  batch.status='queued';q.stopped=false;q.generation++;
  await putDownloadState(q);await downloadBatch();return {ok:true};
}
async function nextDownload() {
  const q=await downloadState();if(q.stopped||!q.items.some(i=>i.status==='queued'))return;
  await chrome.alarms.create('download-next',{when:Date.now()+30000});
  // Continue this finite queue promptly; the alarm recovers if Chrome evicts the worker.
  clearTimeout(downloadTimer);downloadTimer=setTimeout(()=>downloadBatch().catch(()=>{}),1000);
}
async function downloadBatch() {
  if (downloading || syncingReminders) return; downloading=true;
  try {
    if(running || (await get()).job)return;
    const s=await get(), q=await downloadState(), pending=(await chrome.storage.local.get('pending')).pending || {};
    if (Object.keys(pending).length) { await reconcileDownloads(); return; }
    if(q.stopped)return;
    const queued=q.items.find(i=>i.status==='queued');
    if(!queued){for(const b of q.batches)if(b.status==='queued'&&!q.items.some(i=>i.batchId===b.id&&['queued','running'].includes(i.status)))b.status='complete';await putDownloadState(q);return;}
    const batch=q.batches.find(b=>b.id===queued.batchId),modeForState=s.integrationMode||'browser';
    if(!batch||batch.account!==s.account||batch.mode!==modeForState){queued.status='failed';queued.error='账户或保存模式已改变';await putDownloadState(q);await nextDownload();return;}
    const f=s.files[queued.key];
    if(!f||!s.courses.some(c=>c.id===f.courseId&&c.enabled)){queued.status='failed';queued.error='文件索引已改变或课程未启用';await putDownloadState(q);await nextDownload();return;}
    if(!await queueStillAllowed(queued.key,batch.id,q.generation))return;
    queued.status='running';batch.status='running';await putDownloadState(q);
    const mode=s.integrationMode,browser=mode==='browser';
    if(!browser){
      let config;
      try{config=await native({op:'status'});if(!config.capabilities?.includes('saved-path-validation'))throw new Error('请更新 macOS 本地助手后再下载');}catch(e){s.downloadStatus=e.message==='请更新 macOS 本地助手后再下载'?e.message:'本地助手未连接，请检查安装或切换到浏览器模式';await put(s);await finishQueueItem(queued.key,batch.id,'failed',s.downloadStatus);return;}
      if(!config.root){s.downloadStatus='请先选择归档根目录';await put(s);await finishQueueItem(queued.key,batch.id,'failed',s.downloadStatus);return;}
    }
    if(!await queueStillAllowed(queued.key,batch.id,q.generation))return;
    s.downloadStatus=`正在核对：${f.name}`; await put(s);
    let headers;
    try {
      activeDownloadCheck=new AbortController();
      const h=await request(f.url,'HEAD',activeDownloadCheck.signal);
      if ((h.headers.get('content-type')||'').includes('text/html')) throw new Error('附件返回登录页或错误页面');
      f.archiveName=attachmentName(h.headers.get('content-disposition'),h.headers.get('content-type'),f.name);
      f.relative[f.relative.length-1]=f.archiveName;
      headers={etag:h.headers.get('etag'),modified:h.headers.get('last-modified'),size:h.headers.get('content-length')};
      const saved=browser?f.browserDownload:{path:f.savedPath,relative:f.savedRelative,headers:f.headers};
      if (saved?.path && (!browser||JSON.stringify(saved.relative)===JSON.stringify(f.relative)) && (headers.etag || headers.modified) && JSON.stringify(headers)===JSON.stringify(saved.headers)) {
        const exists=browser?(await chrome.downloads.search({id:saved.id}))[0]:await native({op:'existsPath',path:f.savedPath});
        if(exists?.exists===true) { f.error=null;await put(s);await finishQueueItem(queued.key,batch.id,'complete');await nextDownload();return; }
      }
    } catch(e) {
      if(activeDownloadCheck?.signal.aborted){await finishQueueItem(queued.key,batch.id,'cancelled');return;}
      if(/重新登录|登录页/.test(e.message)) { s.downloadStatus=e.message;await put(s);await finishQueueItem(queued.key,batch.id,'failed',e.message);return; }
      headers=null; // Some servers reject HEAD; validate the completed download before recording it.
    } finally {activeDownloadCheck=null;}
    if(!await queueStillAllowed(queued.key,batch.id,q.generation))return;
    if(!await queueStillAllowed(queued.key,batch.id,q.generation))return;
    await put(s);
    const token=crypto.randomUUID(), filename=browser?browserFilename(f.relative,(await platform).os):`BBReader-staging/${token}/${f.archiveName || cleanName(f.name)}`;
    // Persist intent before invoking downloads, so a worker restart cannot orphan a completed file.
    await chrome.storage.local.set({pending:{...pending,[token]:{token,mode,file:f,headers,account:s.account,run:s.lastSync,started:Date.now(),batchId:batch.id,generation:q.generation}}});
    await chrome.alarms.create('download-next',{when:Date.now()+60000});
    try {
      const id=await chrome.downloads.download({url:readURL(f.url),filename,saveAs:false,conflictAction:'uniquify'});
      const p=(await chrome.storage.local.get('pending')).pending || {};
      const latest=await downloadState();
      if(p[token]) { p[token].id=id; await chrome.storage.local.set({pending:p});if(latest.stopped||latest.generation!==q.generation){p[token].cancelRequested=true;await chrome.storage.local.set({pending:p});await chrome.downloads.cancel(id).catch(()=>{});await reconcileDownloads();return;} }
      await reconcileDownloads();
    } catch(e) {
      const p=(await chrome.storage.local.get('pending')).pending||{};delete p[token];await chrome.storage.local.set({pending:p});f.error=e.message;
      s.downloadStatus=`下载失败：${e.message}`; s.warnings.push(`${f.name} 下载失败`); await put(s);await finishQueueItem(queued.key,batch.id,'failed',e.message);
      await nextDownload();
    }
  } finally { downloading=false; }
}
async function queueStillAllowed(key,batchId,generation){const q=await downloadState();return !q.stopped&&q.generation===generation&&q.items.some(i=>i.key===key&&i.batchId===batchId&&['queued','running'].includes(i.status));}
async function finishQueueItem(key,batchId,status,error){const q=await downloadState(),item=q.items.find(i=>i.key===key&&i.batchId===batchId);if(item){item.status=status;if(error)item.error=error;}const batch=q.batches.find(b=>b.id===batchId);if(batch&&!q.items.some(i=>i.batchId===batchId&&['queued','running'].includes(i.status)))batch.status=status==='failed'?'failed':'complete';await putDownloadState(q);}
let reconciling=false;
async function reconcileDownloads() {
  if(reconciling)return;
  if(running || syncingReminders){await chrome.alarms.create('download-next',{when:Date.now()+60000});return;}
  reconciling=true;
  try {
    const p=(await chrome.storage.local.get('pending')).pending || {};
    for(const [token,job] of Object.entries(p)) {
      const mode=job.mode||'macos',browser=mode==='browser';
      const found=job.id!==undefined ? await chrome.downloads.search({id:job.id}) : browser?
        (await chrome.downloads.search({url:readURL(job.file.url),startedAfter:new Date(job.started).toISOString()})).filter(d=>d.byExtensionId===chrome.runtime.id):
        await chrome.downloads.search({filenameRegex:`BBReader-staging/${token}/`});
      const item=found[0];
      if(!item || item.state==='in_progress') {
        if(Date.now()-job.started<24*3600000) {await chrome.alarms.create('download-next',{when:Date.now()+60000});continue;}
      }
      const s=await get(), f=s.files[job.file.key];
      try {
        if(job.cancelRequested&&item?.state!=='complete') {if(mode==='macos'&&item?.filename)await native({op:'discardStaging',token,source:item.filename}).catch(()=>{});await finishQueueItem(job.file.key,job.batchId,'cancelled');delete p[token];await chrome.storage.local.set({pending:p});continue;}
        if(found.length>1)throw new Error('无法唯一识别下载记录，请重新检查文件');
        if(!item || item.state!=='complete') throw new Error(item?.error || '下载未完成');
        if(!f)throw new Error('文件索引已改变');
        if(s.account!==job.account) throw new Error('账户已改变，暂存文件未归档');
        if(item.danger && !['safe','accepted'].includes(item.danger)) throw new Error('浏览器尚未确认此下载安全');
        if(/text\/html/.test(item.mime||'')) throw new Error('附件是 HTML 登录页，未归档');
        if(browser){
          if(item.finalUrl)readURL(item.finalUrl);
          if(item.fileSize===0)throw new Error('下载文件为空');
          f.browserDownload={id:item.id,path:item.filename,relative:job.file.relative,headers:job.headers};
        }else{
          const saved=await native({op:'archive',source:item.filename,token,courseId:f.courseId,relative:f.relative,resourceId:f.id});
          Object.assign(f,{savedPath:saved.path,savedRelative:saved.relative,sha256:saved.sha256,headers:job.headers});
        }
        Object.assign(f,{checkedRun:job.run,checkedMode:mode,error:null});
        s.downloadStatus=`已${browser?'下载':'归档'}：${f.name}`;
        await finishQueueItem(f.key,job.batchId,'complete');
      } catch(e) { if(f){f.error=e.message;} s.downloadStatus=`保存失败：${e.message}`; s.warnings.push(`${job.file.name}：${e.message}`);await finishQueueItem(job.file.key,job.batchId,'failed',e.message); }
      await put(s); delete p[token]; await chrome.storage.local.set({pending:p});
    }
    if(!Object.keys(p).length) {
      const q=await downloadState();
      if(q.stopping){q.stopping=false;await putDownloadState(q);}
      await nextDownload();
    }
  } finally {reconciling=false;}
}
chrome.downloads.onChanged.addListener(d=>{if(d.state)reconcileDownloads().catch(()=>{});});
chrome.alarms.onAlarm.addListener(a=>{
  if(a.name===DAILY) start(true).finally(arm);
  else if(a.name===RESUME) pump();
  else if(a.name==='download-next') downloadBatch();
});
async function syncReminders(connect=false) {
  if(running||downloading||reconciling||syncingReminders)throw new Error('请等待当前同步完成');
  syncingReminders=true;
  try {
    const s=await get();
    if(s.integrationMode!=='macos')throw new Error('请先启用 macOS 系统集成');
    if(!s.account||!s.lastSync||s.job)throw new Error('请先完成一次课程检查');
    const assignments=s.assignments.filter(a=>s.courses.some(c=>c.id===a.courseId&&c.enabled)&&a.checked>=s.lastRun);
    // Reminders for courses the user unticked are removed; nothing else is deleted.
    const removeCourses=s.courses.filter(c=>!c.enabled).map(c=>c.id);
    const result=await native({op:connect?'connectReminders':'syncReminders',account:s.account,assignments,removeCourses});
    const current=await get();
    if(current.account!==s.account)throw new Error('账户已更改，请重新连接提醒事项');
    current.remindersEnabled=true;current.remindersSyncedAt=Date.now();
    current.remindersStatus=`已同步到 ${result.list}：新增 ${result.created}，更新 ${result.updated}`+(result.removed?`，移除 ${result.removed} 项多余提醒`:'')+(result.cleanedNotes?`，清理 ${result.cleanedNotes} 条旧备注`:'');
    for(const a of current.assignments){const key=`${a.courseId}:${a.id}`;if(key in result.completed)a.reminderCompleted=result.completed[key];}
    await put(current);return result;
  } catch(e) {const s=await get();s.remindersStatus=`提醒事项同步失败：${e.message}`;await put(s);throw e;}
  finally {syncingReminders=false;}
}
async function ensureDownloadUpgrade(){
  const stored=(await chrome.storage.local.get('downloadQueue')).downloadQueue;
  if(stored)return;
  const q={stopped:false,generation:1,items:[],batches:[]};await putDownloadState(q);
  const pending=(await chrome.storage.local.get('pending')).pending||{};
  for(const job of Object.values(pending)){job.cancelRequested=true;if(job.id!==undefined)await chrome.downloads.cancel(job.id).catch(()=>{});}
  await chrome.storage.local.set({pending});
  if(Object.keys(pending).length)await chrome.alarms.create('download-next',{when:Date.now()+1000});
}
async function wake() { await arm();await ensureDownloadUpgrade();const migration=(await chrome.storage.local.get('directoryMigration')).directoryMigration;if(migration&&!migration.committed)await runDirectoryMigration(migration).catch(()=>{});const s=await get();if(s.job)await pump();else await start(true);await downloadBatch(); }
chrome.runtime.onStartup.addListener(()=>wake());
chrome.runtime.onInstalled.addListener(({reason}={})=>{wake().catch(()=>{});if(reason==='install')chrome.tabs.create({url:'index.html'});});
chrome.action.onClicked.addListener(()=>chrome.tabs.create({url:'index.html'}));
chrome.runtime.onMessage.addListener((msg,sender,reply)=>{
  if(sender.id!==chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL('index.html')) || msg.target==='parser')return;
  (async()=>{
    if(msg.op==='integration'){
      if(!['browser','macos'].includes(msg.mode))throw new Error('无效的运行模式');
      if(running||downloading||reconciling||syncingReminders||(await get()).job||Object.keys((await chrome.storage.local.get('pending')).pending||{}).length)throw new Error('请等待当前检查和下载结束');
      running=true;
      try {
        if(msg.mode==='macos')await native({op:'status'});
        const s=await get();s.integrationMode=msg.mode;s.authBlocked=false;s.authStatus=null;s.downloadStatus='运行模式已更新，下次检查按此模式保存';await put(s);return {ok:true};
      } finally {running=false;}
    }
    if(msg.op==='completeAssignment'){
      if(running||downloading||reconciling||syncingReminders||(await get()).job)throw new Error('请等待当前检查完成');
      const s=await get(),a=s.assignments.find(a=>a.id===msg.id&&a.courseId===msg.courseId);
      if(!a||typeof msg.completed!=='boolean')throw new Error('无效作业');
      a.localCompleted=msg.completed;await put(s);return {ok:true};
    }
    if(['saveCredentials','deleteCredentials','testLogin','openLogin'].includes(msg.op)) {
      if(running||downloading||reconciling||syncingReminders||(await get()).job)throw new Error('请等待本次检查完成');
      if(msg.op==='openLogin'){await chrome.tabs.create({url:SSO,active:true});return {ok:true};}
      if(msg.op==='testLogin') {running=true;try{await renew({manual:true});return {ok:true};}finally{running=false;}}
      const keychain=(await get()).integrationMode==='macos',saving=msg.op==='saveCredentials';
      if(saving&&!validCredentials(msg.username,msg.password))throw new Error('请填写有效的校园账号和密码');
      if(saving&&!(await chrome.permissions.contains({origins:[CAS_PERMISSION]})))throw new Error('请先允许访问学校认证页面');
      running=true;
      try {
        if(keychain)await native(saving?{op:msg.op,username:msg.username,password:msg.password}:{op:msg.op});
        else if(saving)await saveVault({username:msg.username,password:msg.password});
        else await deleteVault();
        const s=await get();s[keychain?'credentialLogin':'browserCredentialLogin']=saving;s.authBlocked=false;s.lastCredentialDay=null;
        s.authStatus=saving?(keychain?'凭据已保存到钥匙串；每日检查最多尝试一次密码登录':'凭据已加密保存在本机浏览器；每日检查最多尝试一次密码登录'):'已删除保存的凭据，继续复用浏览器登录状态';await put(s);return {ok:true};
      } finally {running=false;}
    }
    if(msg.op==='connectReminders') return syncReminders(true);
    if(msg.op==='syncReminders') return syncReminders();
    if(msg.op==='pauseReminders') {if(syncingReminders||running)throw new Error('请等待当前同步完成');const s=await get();s.remindersEnabled=false;s.remindersStatus='已暂停同步，现有提醒事项保留';await put(s);return {ok:true};}
    if(msg.op==='sync') { start().catch(()=>{});return {ok:true}; }
    if(msg.op==='downloadFiles')return queueDownloads(msg.keys);
    if(msg.op==='stopDownloads')return stopDownloads();
    if(msg.op==='resumeDownloads')return resumeDownloads(msg.batchId);
    if(msg.op==='retryDownloads') {const q=await downloadState(),batch=q.batches.find(b=>b.id===msg.batchId);if(!batch)throw new Error('下载批次不存在');if(downloading||q.items.some(i=>['queued','running'].includes(i.status)))throw new Error('请等待当前下载批次结束后再重试');const failed=q.items.filter(i=>i.batchId===batch.id&&i.status==='failed'&&(!msg.keys||msg.keys.includes(i.key)));if(!failed.length)throw new Error('没有可重试的文件');for(const i of failed){i.status='queued';i.error=null;}batch.status='queued';q.stopped=false;q.generation++;await putDownloadState(q);await downloadBatch();return {ok:true,queued:failed.length};}
    if(msg.op==='state') return {ok:true,state:await get(),downloadQueue:await downloadState(),directoryMigration:(await chrome.storage.local.get('directoryMigration')).directoryMigration||null,platform:(await platform).os,nextCheck:(await chrome.alarms.get(DAILY))?.scheduledTime};
    if(msg.op==='settings') {if(running||downloading||reconciling||syncingReminders||(await get()).job)throw new Error('请等待本次检查完成');if(msg.checkTime!==undefined&&checkTime(msg.checkTime)!==msg.checkTime)throw new Error('无效的检查时间');const s=await get(); s.enabled=!!msg.enabled; s.courses.forEach(c=>c.enabled=msg.selected.includes(c.id)); if(msg.checkTime!==undefined)s.checkTime=msg.checkTime; await put(s);await arm();return {ok:true};}
    if(msg.op==='nativeStatus') {if((await get()).integrationMode!=='macos')throw new Error('未启用系统集成');return native({op:'status'});}
    if(msg.op==='chooseRoot'||msg.op==='chooseCourse') {
      const dq=await downloadState();if(running||downloading||reconciling||syncingReminders||(await get()).job||dq.items.some(i=>['queued','running'].includes(i.status)))throw new Error('请先完成或中止当前操作');
      running=true;
      try {
        const s=await get(),course=msg.op==='chooseCourse'?s.courses.find(c=>c.id===msg.courseId):null;
        if(s.integrationMode!=='macos')throw new Error('请先启用 macOS 系统集成');
        if(msg.op==='chooseCourse'&&!course)throw new Error('未知课程');
        const config=await native({op:'status'});
        if(!config.capabilities?.includes('confirmed-directory-migration')||!config.capabilities?.includes('migration-journal'))throw new Error('请先重新运行 0.4.0 安装包中的“安装本地助手.command”');
        let chosen;
        try {chosen=await chrome.runtime.sendNativeMessage('cn.sustech.bbreader.picker',{op:'chooseFolder',title:course?`选择 ${course.name} 的保存文件夹`:'选择课件保存根目录',directory:course?config.courses?.[course.id]||config.root:config.root});}
        catch {throw new Error('文件夹选择器未连接，请运行最新版安装包中的“安装本地助手.command”');}
        if(!chosen?.ok)throw new Error(chosen?.error||'文件夹选择器未响应');
        if(chosen.cancelled)return {ok:true,cancelled:true};
        const currentPath=course?config.courses?.[course.id]||config.root:config.root;
        if(chosen.path===currentPath)return {ok:true,root:config.root,courses:config.courses,unchanged:true};
        const affected=Object.values(s.files).filter(f=>f.savedPath&&f.sha256&&(!course||f.courseId===course.id)&&(!course?!config.courses?.[f.courseId]:true));
        const id=crypto.randomUUID(),plan={id,account:s.account,scope:course?'course':'root',courseId:course?.id,path:chosen.path,oldPath:currentPath,files:affected.map(f=>({key:f.key,name:f.name,courseId:f.courseId,sourcePath:f.savedPath,relative:f.relative,sha256:f.sha256,status:'pending'}))};
        await chrome.storage.local.set({directoryPlan:plan});return {ok:true,prepared:true,plan};
      } finally {running=false;}
    }
    if(msg.op==='cancelDirectoryChange'){const plan=(await chrome.storage.local.get('directoryPlan')).directoryPlan;if(plan?.id===msg.planId)await chrome.storage.local.remove('directoryPlan');return {ok:true};}
    if(msg.op==='commitDirectoryChange'){
      const plan=(await chrome.storage.local.get('directoryPlan')).directoryPlan;if(!plan||plan.id!==msg.planId)throw new Error('保存目录预览已失效，请重新选择');
      const q=await downloadState(),current=await get();if(plan.account!==current.account||plan.files.some(item=>{const f=current.files[item.key];return !f||f.savedPath!==item.sourcePath||f.sha256!==item.sha256;}))throw new Error('课件列表或保存位置已改变，请重新选择目录');
      if(running||downloading||reconciling||q.items.some(i=>['queued','running'].includes(i.status))||Object.keys((await chrome.storage.local.get('pending')).pending||{}).length)throw new Error('请先完成或中止当前操作');
      running=true;try{plan.migrate=msg.migrate===true;await chrome.storage.local.set({directoryMigration:plan});await chrome.storage.local.remove('directoryPlan');const result=await runDirectoryMigration(plan);return {ok:true,...result};}finally{running=false;}
    }
    if(msg.op==='retryMigration'){const journal=(await chrome.storage.local.get('directoryMigration')).directoryMigration;if(!journal)throw new Error('没有待恢复的迁移');for(const f of journal.files)if(f.status==='failed')f.status='pending';running=true;try{return {ok:true,...await runDirectoryMigration(journal)};}finally{running=false;}}
    if(msg.op==='files') {throw new Error('请在课件归档中选择需要下载的文件');}
    if(msg.op==='feed') {
      const raw=(await (await request(`${ORIGIN}/webapps/calendar/calendarFeed/url`)).text()).trim();
      const match=raw.match(/https:\/\/bb\.sustech\.edu\.cn\/webapps\/calendar\/calendarFeed\/[^\s<>"']+/);
      if(!match)throw new Error('没有取得订阅链接，请到 Blackboard 日历中获取');return {ok:true,url:match[0].replace(/&amp;/g,'&')};
    }
    if(msg.op==='reset') {if(running||downloading||reconciling||syncingReminders||(await get()).job)throw new Error('请等待检查结束');if(Object.keys((await chrome.storage.local.get('pending')).pending||{}).length)throw new Error('请等待下载结束'); await chrome.storage.local.remove(['state','downloadQueue','directoryPlan','directoryMigration']);await deleteVault();return {ok:true};}
    throw new Error('未知操作');
  })().then(reply).catch(e=>reply({ok:false,error:e.message})); return true;
});
// Recreate the next daily alarm after worker eviction; no periodic polling alarm.
chrome.alarms.get(DAILY).then(a=>{if(!a)return wake();}).catch(()=>{});
