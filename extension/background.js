import {courseSettingsURL,selectCurrentCourses} from './courses.js';
import {CAS_PERMISSION,SSO,renewLogin} from './auth.js';
import {saveVault,readVault,deleteVault,validCredentials} from './vault.js';
import { ORIGIN, PORTAL, DAY, campusDay, dailyDue, nextCheck, checkTime, cleanName, sameAccountLabel, browserFilename, readURL, bbURL, digest, calendarDate, attachmentName } from './core.js';
const HOST = 'cn.sustech.bbreader', DAILY = 'daily-nine', RESUME = 'resume-job';
let running = false, creatingParser, syncingReminders=false, queueActive=false;
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
async function request(url, method = 'GET') {
  const r = await fetch(readURL(url), {method, credentials:'include', cache:'no-cache', signal:AbortSignal.timeout(20000)});
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
  s.status = '正在读取课程…'; s.warnings = []; s.downloadAbort=false; await put(s);
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
    // Index-only checks leave downloading to an explicit action from the files view.
    if(s.autoDownload===false){ s.downloadStatus='索引已更新，未下载'; await put(s); }
    else await downloadBatch();
  }
}
let downloading = false;
async function nextDownload() {
  await chrome.alarms.create('download-next',{when:Date.now()+30000});
  // Continue this finite queue promptly; the alarm recovers if Chrome evicts the worker.
  setTimeout(()=>downloadBatch().catch(()=>{}),1000);
}
async function downloadBatch() {
  if (downloading || syncingReminders) return; downloading=true;
  try {
    if(running || (await get()).job)return;
    const s=await get(), pending=(await chrome.storage.local.get('pending')).pending || {};
    // An abort stops the batch until the user starts it again from the files view.
    if (s.downloadAbort) return;
    if (Object.keys(pending).length) { await reconcileDownloads(); return; }
    const mode=s.integrationMode,browser=mode==='browser';
    if(!browser){
      let config;
      try{config=await native({op:'status'});}catch{s.downloadStatus='本地助手未连接，请检查安装或切换到浏览器模式';await put(s);return;}
      if(!config.root){s.downloadStatus='请先选择归档根目录';await put(s);return;}
    }
    const f=Object.values(s.files).find(f=>s.courses.some(c=>c.id===f.courseId && c.enabled) && f.wanted!==false && (f.checkedRun!==s.lastSync||(f.checkedMode||'macos')!==mode) && f.seen===s.lastRun);
    if (!f) { queueActive=false; s.downloadStatus='文件检查完成'; await put(s); return; }
    queueActive=true;
    s.downloadStatus=`正在核对：${f.name}`; await put(s);
    if(!browser&&f.savedRelative&&f.sha256&&JSON.stringify(f.savedRelative)!==JSON.stringify(f.relative)){
      try{
        const relocated=await native({op:'relocate',courseId:f.courseId,sourceRelative:f.savedRelative,relative:f.relative,sha256:f.sha256});
        if(relocated.moved)Object.assign(f,{savedPath:relocated.path,savedRelative:relocated.relative,sha256:relocated.sha256});
      }catch(e){f.error=e.message;f.checkedRun=s.lastSync;f.checkedMode=mode;s.downloadStatus=`整理失败：${e.message}`;s.warnings.push(`${f.name}：${e.message}`);await put(s);await nextDownload();return;}
    }
    let headers;
    try {
      const h=await request(f.url,'HEAD');
      if ((h.headers.get('content-type')||'').includes('text/html')) throw new Error('附件返回登录页或错误页面');
      f.archiveName=attachmentName(h.headers.get('content-disposition'),h.headers.get('content-type'),f.name);
      f.relative[f.relative.length-1]=f.archiveName;
      headers={etag:h.headers.get('etag'),modified:h.headers.get('last-modified'),size:h.headers.get('content-length')};
      const saved=browser?f.browserDownload:{path:f.savedPath,relative:f.savedRelative,headers:f.headers};
      if (saved?.path && JSON.stringify(saved.relative)===JSON.stringify(f.relative) && (headers.etag || headers.modified) && JSON.stringify(headers)===JSON.stringify(saved.headers)) {
        const exists=browser?(await chrome.downloads.search({id:saved.id}))[0]:await native({op:'exists',courseId:f.courseId,relative:f.savedRelative});
        if(exists?.exists===true) { f.checkedRun=s.lastSync;f.checkedMode=mode;f.error=null; await put(s); await nextDownload(); return; }
      }
    } catch(e) {
      if(/重新登录|登录页/.test(e.message)) { s.downloadStatus=e.message; await put(s); return; }
      headers=null; // Some servers reject HEAD; validate the completed download before recording it.
    }
    await put(s);
    const token=crypto.randomUUID(), filename=browser?browserFilename(f.relative,(await platform).os):`BBReader-staging/${token}/${f.archiveName || cleanName(f.name)}`;
    // Persist intent before invoking downloads, so a worker restart cannot orphan a completed file.
    await chrome.storage.local.set({pending:{[token]:{token,mode,file:f,headers,account:s.account,run:s.lastSync,started:Date.now()}}});
    await chrome.alarms.create('download-next',{when:Date.now()+60000});
    try {
      const id=await chrome.downloads.download({url:readURL(f.url),filename,saveAs:false,conflictAction:'uniquify'});
      const p=(await chrome.storage.local.get('pending')).pending || {};
      if(p[token]) { p[token].id=id; await chrome.storage.local.set({pending:p}); }
      await reconcileDownloads();
    } catch(e) {
      await chrome.storage.local.set({pending:{}}); f.checkedRun=s.lastSync;f.checkedMode=mode;f.error=e.message;
      s.downloadStatus=`下载失败：${e.message}`; s.warnings.push(`${f.name} 下载失败`); await put(s);
      await nextDownload();
    }
  } finally { downloading=false; }
}
let reconciling=false;
async function reconcileDownloads() {
  if(reconciling)return;
  // Never re-arm the queue watchdog after an abort.
  if((await get()).downloadAbort)return;
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
      } catch(e) { if(f){f.checkedRun=job.run;f.checkedMode=mode;f.error=e.message;} s.downloadStatus=`保存失败：${e.message}`; s.warnings.push(`${job.file.name}：${e.message}`); }
      await put(s); delete p[token]; await chrome.storage.local.set({pending:p});
    }
    if(!Object.keys(p).length) await nextDownload();
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
async function wake() { await arm(); const s=await get(); if(s.job)await pump(); else await start(true); }
chrome.runtime.onStartup.addListener(()=>wake());
chrome.runtime.onInstalled.addListener(({reason}={})=>{arm();if(reason==='install')chrome.tabs.create({url:'index.html'});});
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
    if(msg.op==='state') return {ok:true,state:await get(),platform:(await platform).os,nextCheck:(await chrome.alarms.get(DAILY))?.scheduledTime,downloading:!!(queueActive||downloading||reconciling)};
    if(msg.op==='settings') {if(running||downloading||reconciling||syncingReminders||(await get()).job)throw new Error('请等待本次检查完成');if(msg.checkTime!==undefined&&checkTime(msg.checkTime)!==msg.checkTime)throw new Error('无效的检查时间');const s=await get(); s.enabled=!!msg.enabled; s.courses.forEach(c=>c.enabled=msg.selected.includes(c.id)); if(msg.checkTime!==undefined)s.checkTime=msg.checkTime; if(msg.autoDownload!==undefined)s.autoDownload=!!msg.autoDownload; await put(s);await arm();return {ok:true};}
    if(msg.op==='nativeStatus') {if((await get()).integrationMode!=='macos')throw new Error('未启用系统集成');return native({op:'status'});}
    if(msg.op==='chooseRoot'||msg.op==='chooseCourse') {
      if(running||downloading||reconciling||syncingReminders||(await get()).job)throw new Error('请等待当前操作结束');
      running=true;
      try {
        const s=await get(),course=msg.op==='chooseCourse'?s.courses.find(c=>c.id===msg.courseId):null;
        if(s.integrationMode!=='macos')throw new Error('请先启用 macOS 系统集成');
        if(msg.op==='chooseCourse'&&!course)throw new Error('未知课程');
        const config=await native({op:'status'});
        let chosen;
        try {chosen=await chrome.runtime.sendNativeMessage('cn.sustech.bbreader.picker',{op:'chooseFolder',title:course?`选择 ${course.name} 的保存文件夹`:'选择课件保存根目录',directory:course?config.courses?.[course.id]||config.root:config.root});}
        catch {throw new Error('文件夹选择器未连接，请运行最新版安装包中的“安装本地助手.command”');}
        if(!chosen?.ok)throw new Error(chosen?.error||'文件夹选择器未响应');
        if(chosen.cancelled)return {ok:true,cancelled:true};
        const result=await native(course?{op:'setCourse',courseId:course.id,path:chosen.path}:{op:'setRoot',path:chosen.path});
        const latest=await get();for(const f of Object.values(latest.files)){if(!course||f.courseId===course.id)f.checkedRun=null;}await put(latest);
        return result;
      } finally {running=false;}
    }
    if(msg.op==='files') {if(running||downloading||reconciling)throw new Error('请等待当前操作结束');const s=await get();s.downloadAbort=false;for(const f of Object.values(s.files)){if(f.error){f.checkedRun=null;f.error=null;}}await put(s); downloadBatch().catch(()=>{});return {ok:true}; }
    if(msg.op==='fileSelection') {
      if(running||downloading||reconciling||syncingReminders||(await get()).job)throw new Error('请等待本次检查完成');
      if(!Array.isArray(msg.changed)||msg.changed.some(c=>!Array.isArray(c)||typeof c[1]!=='boolean'))throw new Error('无效的文件选择');
      const s=await get();
      // An absent flag means wanted, so only excluded files carry one and newly indexed files default in.
      for(const [key,wanted] of msg.changed){const f=s.files[key];if(!f)continue;if(wanted)delete f.wanted;else f.wanted=false;}
      await put(s);return {ok:true};
    }
    if(msg.op==='abortDownload') {
      if(running||syncingReminders||(await get()).job)throw new Error('请等待本次检查完成');
      const s=await get(); s.downloadAbort=true; s.downloadStatus='下载已中止，未保存的文件保留在列表中'; await put(s);
      queueActive=false;
      await chrome.alarms.clear('download-next');
      const pending=(await chrome.storage.local.get('pending')).pending || {};
      // Cancelling lets Chrome discard its partial file instead of leaving an orphan behind.
      // A download whose ID has not been stored yet cannot be cancelled; it is retried later.
      for(const job of Object.values(pending)) { try { if(job.id!==undefined) await chrome.downloads.cancel(job.id); } catch {} }
      await chrome.storage.local.set({pending:{}});
      return {ok:true};
    }
    if(msg.op==='feed') {
      const raw=(await (await request(`${ORIGIN}/webapps/calendar/calendarFeed/url`)).text()).trim();
      const match=raw.match(/https:\/\/bb\.sustech\.edu\.cn\/webapps\/calendar\/calendarFeed\/[^\s<>"']+/);
      if(!match)throw new Error('没有取得订阅链接，请到 Blackboard 日历中获取');return {ok:true,url:match[0].replace(/&amp;/g,'&')};
    }
    if(msg.op==='reset') {if(running||downloading||reconciling||syncingReminders||(await get()).job)throw new Error('请等待检查结束');if(Object.keys((await chrome.storage.local.get('pending')).pending||{}).length)throw new Error('请等待下载结束'); await chrome.storage.local.remove('state');await deleteVault();return {ok:true};}
    throw new Error('未知操作');
  })().then(reply).catch(e=>reply({ok:false,error:e.message})); return true;
});
// Recreate the next daily alarm after worker eviction; no periodic polling alarm.
chrome.alarms.get(DAILY).then(a=>{if(!a)return wake();}).catch(()=>{});
