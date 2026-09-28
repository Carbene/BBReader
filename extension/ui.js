import {CAS_PERMISSION} from './auth.js';
import {makeICS,campusDay,ORIGIN,DAY} from './core.js';
const $=id=>document.getElementById(id), demo=!globalThis.chrome?.runtime?.id;
let archiveConfig={courses:{}},platformOS=demo?(new URLSearchParams(location.search).get('platform')||'mac'):null;
let authBusy=false;
let state={courses:[],assignments:[],files:{}}, downloadQueue={items:[],batches:[],stopped:false}, directoryMigration=null, month=new Date(), dayFilter=null;
let filterValue='open',courseFilter='',query='',fileQuery='',courseDraft=null,noteTimer=null;
const collapsedGroups=new Set();
const selectedFiles=new Set();
{const [y,m]=campusDay().split('-').map(Number);month=new Date(y,m-1,1);}
const labels={unknown:'提交状态待核对',submitted:'已提交',graded:'已评阅'};
const VIEWS={
  agenda:['作业日程','作业按期整理，课件按需归档。'],
  courses:['我的课程','当前学期的全部已注册课程，包括 Blackboard 首页隐藏的课程。'],
  files:['课件归档','先查看课件列表，再下载全部或指定文件。'],
  settings:['连接与设置','运行模式、学校登录、日历订阅与同步记录。']
};
const PALETTE=['#2f7d6d','#3a6fbf','#b85a2c','#7a56b8','#a8456f','#2b8196','#8a6d17','#4f7f2a'];
const TZ='Asia/Shanghai';
const format=t=>new Intl.DateTimeFormat('zh-CN',{timeZone:TZ,year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(t));
const formatDue=t=>new Intl.DateTimeFormat('zh-CN',{timeZone:TZ,month:'short',day:'numeric',weekday:'short',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(t));
const courseColor=id=>PALETTE[[...String(id)].reduce((n,c)=>(n*31+c.charCodeAt(0))>>>0,7)%PALETTE.length];

// Preview data for the standalone page (not the extension). Clearly labelled as sample data.
const previewState=(()=>{
  const at=(days,h=23,m=59)=>{const d=new Date(Date.parse(`${campusDay(Date.now()+days*DAY)}T00:00:00+08:00`)+(h*60+m)*60000);return d.toISOString();};
  const courses=[['_1_1','示例课程 · 编译原理','CS323-2026FA'],['_2_1','示例课程 · 计算机网络','CS305-2026FA'],['_3_1','示例课程 · 深度学习','CS324-2026FA'],['_4_1','示例课程 · 概率论','MA212-2026FA']].map(([id,name,code],i)=>({id,name,code,enabled:i<3,term:'2026 秋（示例）'}));
  const a=(id,c,title,due,status,extra={})=>({id,courseId:c.id,courseName:c.name,title,due,status,url:ORIGIN,checked:Date.now(),...extra});
  const [c1,c2,c3]=courses;
  const files={};
  [['Lecture 01 · Introduction.pdf',c1,'浏览器下载目录/BBReader/2026 秋/编译原理/Lectures/Lecture 01 · Introduction.pdf'],['Lecture 02 · Lexing.pptx',c1,'浏览器下载目录/BBReader/2026 秋/编译原理/Lectures/Lecture 02 · Lexing.pptx'],['Lab 1 handout.pdf',c2,'浏览器下载目录/BBReader/2026 秋/计算机网络/Labs/Lab 1 handout.pdf'],['starter-code.zip',c2,null],['Syllabus.pdf',c3,'浏览器下载目录/BBReader/2026 秋/深度学习/Syllabus.pdf']].forEach(([name,c,path],i)=>{files[`${c.id}:${i}`]={key:`${c.id}:${i}`,courseId:c.id,name,url:ORIGIN,browserDownload:path?{path}:undefined,error:i===3?'附件返回登录页或错误页面':null};});
  return {status:'课程和作业检查完成',lastSync:Date.now()-2*3600000,lastRun:Date.now()-2*3600000,account:'preview',accountLabel:'示例账户',enabled:true,integrationMode:'browser',currentTerm:{name:'2026 秋（示例）'},downloadStatus:'文件检查完成',warnings:['示例课程 · 计算机网络: starter-code.zip 下载失败'],files,courses,assignments:[
    a('_a1',c1,'Assignment 1 · Lexical Analysis',at(0,23,59),'unknown'),
    a('_a2',c2,'Lab 2 · Wireshark 抓包',at(1,16,0),'unknown'),
    a('_a3',c3,'Homework 1 · Linear Models',at(4),'unknown'),
    a('_a4',c1,'Assignment 2 · Parsing',at(12),'unknown'),
    a('_a5',c2,'Lab 1 · Socket Programming',at(-2,22,0),'submitted'),
    a('_a6',c3,'课程声明表',at(-1,12,0),'unknown'),
    a('_a7',c2,'Project Proposal',null,'unknown')]};
})();

async function api(msg){if(demo){if(msg.op==='state')return{state:previewState,downloadQueue,nextCheck:Date.parse(`${campusDay(Date.now()+DAY)}T09:00:00+08:00`)};throw new Error('这是界面预览，请在 Chrome 插件中操作');}const r=await chrome.runtime.sendMessage(msg);if(!r?.ok)throw new Error(r?.error||'未收到响应');return r;}
function el(tag,txt,cls){const e=document.createElement(tag);if(txt!==undefined&&txt!==null)e.textContent=txt;if(cls)e.className=cls;return e;}
function note(text){
  clearTimeout(noteTimer);$('message').textContent=text||'';$('message').hidden=!text;
  if(text)noteTimer=setTimeout(()=>{$('message').hidden=true;},7000);
}
function link(title,url){const a=el('a',title);if(/^https:\/\//.test(url||'')){a.href=url;a.target='_blank';a.rel='noreferrer';}return a;}
async function refresh(){try{const response=await api({op:'state'}),previous=state.integrationMode;state=response.state;downloadQueue=response.downloadQueue||downloadQueue;directoryMigration=response.directoryMigration||null;platformOS=response.platform||platformOS;for(const key of selectedFiles)if(!state.files[key]||!enabledCourse(state.files[key].courseId))selectedFiles.delete(key);if(state.integrationMode==='macos'&&previous!=='macos'){try{archiveConfig=await api({op:'nativeStatus'});}catch(e){archiveConfig={courses:{},error:e.message};}}render();$('nextCheck').textContent=state.enabled!==false&&response.nextCheck?`下次自动检查：${format(response.nextCheck)}（UTC+8）`:'';}catch(e){note(e.message);}}
const isDone=a=>state.integrationMode==='macos'?a.reminderCompleted===true||['submitted','graded'].includes(a.status):a.localCompleted??['submitted','graded'].includes(a.status);
const enabledCourse=id=>state.courses.some(c=>c.id===id&&c.enabled);
function activeAssignments(){return state.assignments.filter(a=>enabledCourse(a.courseId));}
const activeFiles=()=>Object.values(state.files||{}).filter(f=>enabledCourse(f.courseId));
const fileSaved=f=>state.integrationMode==='macos'?f.savedPath:f.browserDownload?.path;

function renderIntegration(){
  const integrated=state.integrationMode==='macos';
  document.querySelectorAll('[data-macos]').forEach(e=>e.hidden=platformOS!=='mac');
  document.querySelectorAll('[data-integrated]').forEach(e=>e.hidden=!integrated);
  $('modeBadge').textContent=integrated?'macOS 系统集成':'浏览器独立模式';
  $('modeBadge').dataset.state=integrated?'enabled':'browser';
  $('modeDescription').textContent=integrated?'使用本地助手归档课件，可连接钥匙串与 Apple 提醒事项。':'无需安装本地助手，课件直接保存到浏览器下载目录。';
  $('toggleIntegration').textContent=integrated?'切换为浏览器独立模式':'启用 macOS 系统集成';
  $('browserDownloadHint').hidden=integrated;
  $('helper').textContent=integrated?(archiveConfig.error|| (archiveConfig.root?`归档根目录：${archiveConfig.root}`:'本地助手已连接，请选择保存文件夹。')):'浏览器下载目录 / BBReader / 学期 / 课程 / 内容目录';
  $('retryMigration').hidden=!directoryMigration?.files?.some(f=>f.status==='failed');
}

function renderStatus(){
  const busy=!!state.job,needsLogin=!busy&&/重新登录|统一认证|学校登录/.test(state.lastError||'');
  $('status').textContent=state.status||'尚未连接';
  $('statusDot').dataset.state=busy?'busy':state.lastError||state.warnings?.length?'warn':state.account?'ok':'idle';
  $('lastSync').textContent=state.lastSync?`上次检查 ${format(state.lastSync)}`:'首次使用：点击「立即检查」连接课程';
  $('sync').disabled=busy;$('sync').classList.toggle('busy',busy);$('sync').querySelector('.label').textContent=busy?'检查中…':'立即检查';
  const active=downloadQueue.items.filter(i=>['queued','running'].includes(i.status));
  const resumable=[...(downloadQueue.batches||[])].reverse().find(b=>downloadQueue.items.some(i=>i.batchId===b.id&&i.status==='cancelled'));
  $('stopDownloads').hidden=false;$('stopDownloads').textContent=downloadQueue.stopping?'正在中止…':'中止下载';$('stopDownloads').disabled=!active.length||!!downloadQueue.stopping||(busy&& !downloadQueue.items.some(i=>i.status==='running'));
  $('resumeDownloads').hidden=!resumable;$('resumeDownloads').textContent=resumable?`恢复下载（${downloadQueue.items.filter(i=>i.batchId===resumable.id&&i.status==='cancelled').length}）`:'恢复下载';$('resumeDownloads').dataset.batchId=resumable?.id||'';
  $('progress').hidden=!busy;
  if(busy){const total=state.job.done+(state.job.queue?.length||0),bar=$('progress').firstElementChild;
    $('progress').classList.toggle('indeterminate',!total);bar.style.width=total?`${Math.max(4,Math.round(state.job.done/total*100))}%`:'';}
  $('loginBanner').hidden=!needsLogin;if(needsLogin)$('loginBannerText').textContent=state.lastError.replace(/[。.]?$/,'。')+(state.account?'上次读取的数据已保留。':'');
  $('onboarding').hidden=!!state.account||busy||$('agenda').hidden;
  const open=activeAssignments().filter(a=>!isDone(a)).length,files=activeFiles().length;
  const badge=(id,v)=>{$(id).hidden=!v;$(id).textContent=v||'';};
  badge('navAgenda',open);badge('navCourses',state.courses.length?`${state.courses.filter(c=>c.enabled).length}/${state.courses.length}`:'');badge('navFiles',files);
  $('navSettings').hidden=!(state.warnings?.length||state.lastError);$('navSettings').title='有需要核对的同步记录';
}

function groupOf(a){
  if(!a.due)return 'none';
  const due=Date.parse(a.due);if(due<Date.now())return 'past';
  const diff=Math.round((Date.parse(campusDay(due))-Date.parse(campusDay()))/DAY);
  return diff<=0?'today':diff===1?'tomorrow':diff<7?'week':'later';
}
const GROUPS=[['past','已过截止'],['today','今天'],['tomorrow','明天'],['week','未来七天'],['later','更晚'],['none','未设置精确截止时间']];
function relative(ms){
  const d=ms-Date.now(),abs=Math.abs(d);
  const t=abs<3600000?`${Math.max(1,Math.round(abs/60000))} 分钟`:abs<2*DAY?`${Math.round(abs/3600000)} 小时`:`${Math.round(abs/DAY)} 天`;
  return d>=0?`还剩 ${t}`:`已逾期 ${t}`;
}

function assignmentCard(a){
  const done=isDone(a),due=a.due?Date.parse(a.due):null,late=!done&&due&&due<Date.now(),soon=!done&&due&&due>=Date.now()&&due-Date.now()<2*DAY;
  const card=el('article',undefined,'assignment'+(done?' done':''));card.style.setProperty('--course',courseColor(a.courseId));
  const check=el('div',undefined,'check');
  if(state.integrationMode!=='macos'){
    const checkbox=el('input');checkbox.type='checkbox';checkbox.checked=done;checkbox.title='标记为已完成（仅保存在本机，不会提交作业）';checkbox.setAttribute('aria-label',`标记完成：${a.courseName} · ${a.title}`);
    checkbox.onchange=()=>run(async()=>{checkbox.disabled=true;try{await api({op:'completeAssignment',courseId:a.courseId,id:a.id,completed:checkbox.checked});await refresh();}catch(e){checkbox.checked=isDone(a);throw e;}finally{checkbox.disabled=false;}});
    check.append(checkbox);
  }
  const body=el('div',undefined,'body');body.append(el('div',a.courseName,'course-label'),el('h3',a.title));
  const meta=el('div',undefined,'meta');
  meta.append(el('span',due?`${formatDue(due)} 截止`:'未设置精确截止时间'));
  if(due&&!done)meta.append(el('span',relative(due),late?'late':soon?'soon':''));
  if(a.dueSource==='calendar')meta.append(el('span','来自 Blackboard 日历'));
  body.append(meta);
  const side=el('div',undefined,'side');
  const status=state.integrationMode==='macos'&&a.reminderCompleted?'Reminders 已完成':a.localCompleted&&!['submitted','graded'].includes(a.status)?'已标记完成':labels[a.status]||labels.unknown;
  side.append(el('span',status,'badge'+(done?' ok':'')),link('查看作业 ↗',a.url));
  card.append(check,body,side);
  if(state.lastRun&&(!a.checked||a.checked<state.lastRun))card.append(el('small','此次未确认，显示上次记录；请以 Blackboard 为准','stale'));
  return card;
}

function renderAgenda(){
  const all=activeAssignments(),open=all.filter(a=>!isDone(a)),now=Date.now();
  $('weekCount').textContent=open.filter(a=>a.due&&Date.parse(a.due)>=now&&Date.parse(a.due)<now+7*DAY).length;
  const late=open.filter(a=>a.due&&Date.parse(a.due)<now).length;$('lateCount').textContent=late;
  document.querySelector('.metric.attention').classList.toggle('has-items',late>0);
  $('courseCount').textContent=state.courses.filter(c=>c.enabled).length;
  document.querySelectorAll('[data-filter]').forEach(b=>b.classList.toggle('active',b.dataset.filter===filterValue));
  const select=$('courseFilter'),courses=state.courses.filter(c=>c.enabled);
  if(courseFilter&&!courses.some(c=>c.id===courseFilter))courseFilter='';
  select.replaceChildren(el('option','所有课程'),...courses.map(c=>{const o=el('option',c.name);o.value=c.id;return o;}));select.firstChild.value='';select.value=courseFilter;
  const q=query.trim().toLowerCase();
  const items=all.filter(a=>(filterValue==='all'||(filterValue==='submitted')===isDone(a))&&(!courseFilter||a.courseId===courseFilter)&&(!q||`${a.title} ${a.courseName}`.toLowerCase().includes(q))&&(!dayFilter||a.due&&campusDay(Date.parse(a.due))===dayFilter)).sort((a,b)=>(Date.parse(a.due)||Infinity)-(Date.parse(b.due)||Infinity));
  $('assignments').replaceChildren();
  for(const [key,title] of GROUPS){
    const list=items.filter(a=>groupOf(a)===key);if(!list.length)continue;
    const heading=el('h3',undefined,'group-title'+(key==='past'&&list.some(a=>!isDone(a))?' late':''));heading.append(title,el('small',`${list.length} 项`));
    $('assignments').append(heading,...list.map(assignmentCard));
  }
  if(!items.length){
    const empty=el('div',undefined,'empty');
    if(!state.account)empty.append(el('b','还没有作业'),'连接 Blackboard 后，作业会按截止时间排列在这里。');
    else if(filterValue==='open'&&!dayFilter&&!q&&!courseFilter)empty.append(el('b','全部完成'),'当前没有待办作业。未读到的内容请以 Blackboard 为准。');
    else empty.append(el('b','没有符合条件的作业'),'试试调整筛选条件。');
    $('assignments').append(empty);
  }
  $('dayChip').hidden=!dayFilter;
  if(dayFilter){const [,m,d]=dayFilter.split('-').map(Number);$('dayChipText').textContent=`${m} 月 ${d} 日`;}
  renderMonth(all);
}

function renderMonth(all){const y=month.getFullYear(),m=month.getMonth();$('monthTitle').textContent=`${y} 年 ${m+1} 月`;$('month').replaceChildren();
  const offset=(new Date(y,m,1).getDay()+6)%7;for(let i=0;i<offset;i++)$('month').append(el('span'));
  for(let d=1;d<=new Date(y,m+1,0).getDate();d++){const key=`${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`,b=el('button',String(d));
    const events=all.filter(a=>a.due&&campusDay(Date.parse(a.due))===key),count=events.length;
    if(count)b.classList.add('has-event');if(events.some(a=>!isDone(a)&&Date.parse(a.due)<Date.now()))b.classList.add('has-late');
    if((offset+d-1)%7>=5)b.classList.add('weekend');if(key===campusDay())b.classList.add('today');if(key===dayFilter)b.classList.add('selected');
    b.setAttribute('aria-label',`${m+1} 月 ${d} 日，${count} 项作业`);b.setAttribute('aria-pressed',String(key===dayFilter));if(count)b.title=events.map(a=>a.title).join('\n');
    b.onclick=()=>{dayFilter=dayFilter===key?null:key;if(dayFilter)filterValue='all';renderAgenda();};$('month').append(b);}
}

function updateCourseBar(){
  const boxes=[...document.querySelectorAll('[data-course]')],checked=boxes.filter(b=>b.checked);
  const dirty=boxes.some(b=>b.checked!==!!state.courses.find(c=>c.id===b.dataset.course)?.enabled);
  courseDraft=dirty?new Set(checked.map(b=>b.dataset.course)):null;
  boxes.forEach(b=>b.closest('.course').classList.toggle('off',!b.checked));
  $('courseSelection').textContent=boxes.length?`已选择 ${checked.length} / ${boxes.length} 门课程${dirty?' · 有未保存的更改':''}`:'';
  $('courseSaveBar').classList.toggle('dirty',dirty);$('courseSaveBar').hidden=!boxes.length;
  $('saveCourses').disabled=!dirty;
}
function askDirectoryMigration(plan){
  const dlg=$('directoryMigrationDialog');$('directoryMigrationText').textContent=`将保存目录改为“${plan.path}”。发现 ${plan.files.length} 个已有课件。迁移会在本机进行并校验文件，不会重新下载；选择不迁移时，已有课件保留原位置。`;
  return new Promise(resolve=>{dlg.onclose=()=>resolve(dlg.returnValue||'cancel');dlg.showModal();});
}
async function changeDirectory(op,courseId){
  const r=await api({op,...(courseId?{courseId}:{})});if(r.cancelled)return;
  if(!r.prepared){helper(r);return;}
  const plan=r.plan;let choice='keep';
  if(plan.files.length)choice=await askDirectoryMigration(plan);
  if(choice==='cancel'){await api({op:'cancelDirectoryChange',planId:plan.id});note('已取消切换，原目录和文件未改变。');return;}
  const result=await api({op:'commitDirectoryChange',planId:plan.id,migrate:choice==='migrate'});
  archiveConfig=await api({op:'nativeStatus'});await refresh();renderCourses();
  if(choice==='migrate')note(`保存目录已更新：迁移 ${result.migrated} 个文件${result.failed?`，${result.failed} 个未迁移成功，可核对后重试`:''}。`);
  else note('保存目录已更新；已有文件留在原位置，之后手动下载的文件将保存到新目录。');
}
function renderCourses(){
  $('courseList').replaceChildren();
  for(const c of state.courses){
    const row=el('article',undefined,'course'),label=el('label'),input=el('input'),body=el('div',undefined,'body'),swatch=el('span',undefined,'swatch');
    row.style.setProperty('--course',courseColor(c.id));
    input.type='checkbox';input.checked=courseDraft?courseDraft.has(c.id):c.enabled;input.dataset.course=c.id;input.onchange=updateCourseBar;
    body.append(el('strong',c.name),el('small',[c.code,c.term].filter(Boolean).join(' · ')));
    const directory=el('small',state.integrationMode==='macos'?(archiveConfig.courses?.[c.id]||'使用默认根目录'):`下载目录 / BBReader / ${c.term} / ${c.name}`);directory.dataset.coursePath=c.id;body.append(directory);
    const choose=el('button','选择保存文件夹…');choose.type='button';choose.onclick=()=>run(async()=>{choose.disabled=true;try{note('请在 macOS 窗口中选择保存文件夹。');await changeDirectory('chooseCourse',c.id);}finally{choose.disabled=false;}});choose.hidden=state.integrationMode!=='macos';
    body.append(choose);label.append(input,swatch,body);row.append(label);$('courseList').append(row);
  }
  if(!state.courses.length){const empty=el('div',undefined,'empty');empty.style.gridColumn='1/-1';empty.append(el('b','尚未发现课程'),'先点击「立即检查」读取当前学期的课程。');$('courseList').append(empty);}
  updateCourseBar();
}

function renderFiles(){
  const files=activeFiles(),q=fileQuery.trim().toLowerCase();
  const saved=files.filter(fileSaved).length,failed=downloadQueue.items.filter(i=>i.status==='failed'&&files.some(f=>f.key===i.key)).length,queued=downloadQueue.items.filter(i=>['queued','running'].includes(i.status)&&files.some(f=>f.key===i.key)).length,never=files.length-saved-failed-queued;
  $('fileSummary').replaceChildren(...(files.length?[el('span',`共 ${files.length} 份`),el('span',`已保存 ${saved}`,'ok'),el('span',`未下载 ${Math.max(0,never)}`),...(queued?[el('span',`队列 ${queued}`)]:[]),...(failed?[el('span',`失败 ${failed}`,'err')]:[])]:[]));
  const visible=files.filter(f=>state.courses.some(c=>c.id===f.courseId&&c.enabled)&&(!q||`${f.name} ${fileSaved(f)||''}`.toLowerCase().includes(q)));
  const selected=[...selectedFiles].filter(key=>files.some(f=>f.key===key));
  $('downloadSelected').textContent=`下载所选（${selected.length}）`;$('downloadSelected').disabled=!selected.length||!!state.job;
  $('downloadAll').disabled=!files.length||!!state.job;
  $('selectVisibleFiles').disabled=!visible.length||!!state.job;$('clearFileSelection').disabled=!selected.length;
  const active=downloadQueue.items.some(i=>['queued','running'].includes(i.status));
  $('downloadStatus').textContent=active?'正在处理用户选择的下载队列。':downloadQueue.stopped?'下载已中止；可从原批次恢复。':state.downloadStatus||'检查只更新课件列表；选择文件后才会下载。';
  $('fileList').replaceChildren();
  for(const c of state.courses.filter(c=>c.enabled)){
    const list=files.filter(f=>f.courseId===c.id&&(!q||`${f.name} ${fileSaved(f)||''}`.toLowerCase().includes(q))).sort((a,b)=>(a.name||'').localeCompare(b.name||'','zh-CN'));
    if(!list.length)continue;
    const group=el('details',undefined,'file-group'),summary=el('summary');group.style.setProperty('--course',courseColor(c.id));
    group.open=!!q||!collapsedGroups.has(c.id);group.ontoggle=()=>{if(!q)group.open?collapsedGroups.delete(c.id):collapsedGroups.add(c.id);};
    summary.append(el('span',undefined,'swatch'),c.name,el('small',`${list.filter(fileSaved).length} / ${list.length} 已保存`));group.append(summary);
    for(const f of list){
      const row=el('div',undefined,'file'),body=el('div'),path=fileSaved(f);
      const box=el('input');box.type='checkbox';box.className='select-file';box.checked=selectedFiles.has(f.key);box.setAttribute('aria-label',`选择 ${f.name}`);box.onchange=()=>{box.checked?selectedFiles.add(f.key):selectedFiles.delete(f.key);renderFiles();};row.append(box);
      const item=[...downloadQueue.items].reverse().find(i=>i.key===f.key),status=path?'已保存':item?.status==='running'?'下载中':item?.status==='queued'?'排队中':item?.status==='cancelled'?'下载已中止':item?.status==='failed'?'下载失败':'未下载';
      row.append(el('span',undefined,'state'+(f.error?' err':path?' ok':'')));
      body.append(el('strong',f.name),el('small',f.error||path||status,f.error?'err':''));
      const action=el('button',path?'重新下载':'下载','ghost file-action');action.type='button';action.disabled=!!state.job||item?.status==='queued'||item?.status==='running';action.onclick=()=>run(async()=>{await api({op:'downloadFiles',keys:[f.key]});await refresh();});
      row.append(body,action,link('原文件 ↗',f.url));group.append(row);
    }
    $('fileList').append(group);
  }
  if(!$('fileList').children.length){const empty=el('div',undefined,'empty');empty.append(el('b',files.length?'没有匹配的文件':'还没有课件'),files.length?'换个关键词试试。':'检查课程后，这里会显示课件与保存位置。');$('fileList').append(empty);}
}

function render(){
  renderIntegration();renderStatus();renderAgenda();
  const time=state.checkTime||'09:00';
  $('scheduleText').textContent=state.enabled===false?'自动检查已关闭':`每天 ${time} 自动检查`;
  $('checkTimeBadge').textContent=time;$('remindersSchedule').textContent=time;
  // Keychain on macOS integration; otherwise the encrypted browser vault (see vault.js).
  const keychain=state.integrationMode==='macos',saved=keychain?state.credentialLogin===true:state.browserCredentialLogin===true;
  $('authStatus').textContent=state.authStatus||(saved?'已保存账号：登录过期时自动登录，每日最多尝试一次。':'复用当前浏览器的学校登录状态；也可保存账号，登录过期时自动登录。');
  $('authBadge').textContent=saved&&state.authBlocked?'需要重新连接':saved?'自动登录已开启':'浏览器登录';
  $('authBadge').dataset.state=saved&&state.authBlocked?'paused':saved?'enabled':'browser';
  $('credentialNote').textContent=keychain?'密码保存在本机钥匙串，仅用于学校统一认证。':'密码经加密保存在当前 Chrome 配置中，仅用于学校统一认证；安全性低于系统钥匙串。';
  $('keychainHint').hidden=keychain||platformOS!=='mac';
  $('deleteCredentials').hidden=!saved;
  $('courseScope').textContent=state.currentTerm?`${state.currentTerm.name} · 已注册课程，不受 Blackboard 首页显示设置影响。取消勾选的课程不会读取作业或下载课件。`:'检查后将自动读取当前学期的已注册课程。';
  if(!courseDraft)renderCourses();
  renderFiles();
  $('remindersStatus').textContent=state.remindersStatus||'尚未连接';
  $('remindersLastSync').textContent=state.remindersSyncedAt?`上次同步：${format(state.remindersSyncedAt)}`:'';
  $('connectReminders').textContent=state.remindersEnabled?'重新连接':'连接 Apple Reminders';
  $('syncReminders').disabled=!state.remindersEnabled;
  $('pauseReminders').disabled=!state.remindersEnabled;
  $('account').textContent=state.accountLabel?`当前账户：${state.accountLabel}`:'尚未连接账户';
  $('warnings').replaceChildren(...(state.warnings||[]).slice(-30).reverse().map(t=>el('p',t,'warn')));
  if(state.lastError)$('warnings').prepend(el('p',state.lastError,'warn'));
  if(!$('warnings').children.length)$('warnings').append(el('p','暂无错误记录。'));
}

async function run(fn){note('');try{await fn();}catch(e){note(e.message);}}
function download(name,text,type){const url=URL.createObjectURL(new Blob([text],{type})),a=el('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),5000);}
function showView(view){
  if(!VIEWS[view])view='agenda';
  for(const id of Object.keys(VIEWS))$(id).hidden=id!==view;
  document.querySelectorAll('[data-view]').forEach(x=>{const on=x.dataset.view===view;x.classList.toggle('active',on);on?x.setAttribute('aria-current','page'):x.removeAttribute('aria-current');});
  [$('title').textContent,$('subtitle').textContent]=VIEWS[view];
  document.title=`${VIEWS[view][0]} · BBReader`;
  if(location.hash!==`#/${view}`)history.replaceState(null,'',`#/${view}`);
  if(view==='settings'){$('auto').checked=state.enabled!==false;$('checkTime').value=state.checkTime||'09:00';$('checkTime').disabled=!$('auto').checked;}
  renderStatus();
}
document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>showView(b.dataset.view));
const hashView=()=>location.hash.replace(/^#\/?/,'');
window.addEventListener('hashchange',()=>showView(hashView()));
document.querySelector('.brand').onclick=e=>{e.preventDefault();showView('agenda');};
$('sync').onclick=()=>run(async()=>{await api({op:'sync'});note('正在读取 Blackboard，请稍候。');setTimeout(refresh,500);});
$('downloadAll').onclick=()=>run(async()=>{const r=await api({op:'downloadFiles',keys:activeFiles().map(f=>f.key)});await refresh();note(`已将 ${r.queued} 个课件加入下载队列。`);});
$('downloadSelected').onclick=()=>run(async()=>{const r=await api({op:'downloadFiles',keys:[...selectedFiles]});selectedFiles.clear();await refresh();note(`已将 ${r.queued} 个课件加入下载队列。`);});
$('selectVisibleFiles').onclick=()=>{const q=fileQuery.trim().toLowerCase();for(const f of activeFiles())if(!q||`${f.name} ${fileSaved(f)||''}`.toLowerCase().includes(q))selectedFiles.add(f.key);renderFiles();};
$('clearFileSelection').onclick=()=>{selectedFiles.clear();renderFiles();};
$('stopDownloads').onclick=()=>run(async()=>{const result=await api({op:'stopDownloads'});await refresh();note(result.stopping?'正在中止下载，完成后会停止后续任务。':'已中止下载；课程检查仍会继续。');});
$('resumeDownloads').onclick=()=>run(async()=>{await api({op:'resumeDownloads',batchId:$('resumeDownloads').dataset.batchId});await refresh();note('正在恢复此批次中止的课件。');});
document.querySelectorAll('[data-filter]').forEach(b=>b.onclick=()=>{filterValue=b.dataset.filter;renderAgenda();});
document.querySelectorAll('[data-metric]').forEach(b=>b.onclick=()=>{if(b.dataset.metric==='courses')return showView('courses');filterValue='open';dayFilter=null;courseFilter='';query='';$('search').value='';renderAgenda();});
$('courseFilter').onchange=()=>{courseFilter=$('courseFilter').value;renderAgenda();};
$('search').oninput=()=>{query=$('search').value;renderAgenda();};
$('fileSearch').oninput=()=>{fileQuery=$('fileSearch').value;renderFiles();};
$('prevMonth').onclick=()=>{month=new Date(month.getFullYear(),month.getMonth()-1,1);renderMonth(activeAssignments());};
$('nextMonth').onclick=()=>{month=new Date(month.getFullYear(),month.getMonth()+1,1);renderMonth(activeAssignments());};
$('todayMonth').onclick=()=>{const [y,m]=campusDay().split('-').map(Number);month=new Date(y,m-1,1);renderMonth(activeAssignments());};
$('clearDay').onclick=()=>{dayFilter=null;renderAgenda();};
$('selectAll').onclick=()=>{document.querySelectorAll('[data-course]').forEach(b=>b.checked=true);updateCourseBar();};
$('selectNone').onclick=()=>{document.querySelectorAll('[data-course]').forEach(b=>b.checked=false);updateCourseBar();};
$('saveCourses').onclick=()=>run(async()=>{await api({op:'settings',enabled:state.enabled!==false,selected:[...document.querySelectorAll('[data-course]:checked')].map(x=>x.dataset.course)});courseDraft=null;await refresh();note('课程选择已保存，下次检查生效。');});
$('auto').onchange=()=>{$('checkTime').disabled=!$('auto').checked;};
$('saveSchedule').onclick=()=>run(async()=>{const time=$('checkTime').value;if(!/^\d{2}:\d{2}$/.test(time))throw new Error('请填写检查时间');await api({op:'settings',enabled:$('auto').checked,checkTime:time,selected:state.courses.filter(c=>c.enabled).map(c=>c.id)});await refresh();note($('auto').checked?`已保存：每天 ${time}（UTC+8）自动检查${state.remindersEnabled?'，完成后同步提醒事项':''}。`:'已关闭每日自动检查。');});
function helper(r){archiveConfig=r;renderIntegration();document.querySelectorAll('[data-course-path]').forEach(e=>e.textContent=r.courses?.[e.dataset.coursePath]||'使用默认根目录');}
$('toggleIntegration').onclick=()=>run(async()=>{
  const mode=state.integrationMode==='macos'?'browser':'macos';
  if(mode==='macos'&&!demo&&!(await chrome.permissions.request({permissions:['nativeMessaging']})))throw new Error('未允许连接本地助手');
  $('toggleIntegration').disabled=true;
  try{await api({op:'integration',mode});await refresh();renderCourses();note('运行模式已更新，现有文件与系统配置均保留。');}finally{$('toggleIntegration').disabled=false;}
});
$('chooseRoot').onclick=()=>run(async()=>{$('chooseRoot').disabled=true;try{note('请在 macOS 窗口中选择保存文件夹。');await changeDirectory('chooseRoot');}finally{$('chooseRoot').disabled=false;}});
$('retryMigration').onclick=()=>run(async()=>{const r=await api({op:'retryMigration'});await refresh();note(`迁移重试完成：迁移 ${r.migrated} 个文件${r.failed?`，仍有 ${r.failed} 个失败`:''}。`);});
$('checkHelper').onclick=()=>run(async()=>helper(await api({op:'nativeStatus'})));
for(const op of ['connectReminders','syncReminders','pauseReminders'])$(op).onclick=()=>run(async()=>{$(op).disabled=true;try{note(op==='connectReminders'?'请在 macOS 提示中允许 BBReader Helper 访问提醒事项。':'正在同步提醒事项…');await api({op});await refresh();note(state.remindersStatus);}finally{$(op).disabled=false;}});
for(const id of ['bannerLogin','onboardLogin'])$(id).onclick=()=>run(async()=>{await api({op:'openLogin'});note('完成学校登录后，点击“立即检查”。');});
$('message').onclick=()=>note('');
function updateAuthControls(){
  for(const id of ['casUsername','casPassword','saveCredentials','testLogin','openLogin','deleteCredentials'])$(id).disabled=authBusy;
  $('saveCredentials').disabled=authBusy||!$('casUsername').value.trim()||!$('casPassword').value;
  $('authForm').setAttribute('aria-busy',String(authBusy));
}
async function authAction(id,label,action){
  if(authBusy)return;
  authBusy=true;const original=$(id).textContent;$(id).textContent=label;updateAuthControls();
  try{await run(action);}finally{authBusy=false;$(id).textContent=original;updateAuthControls();}
}
for(const id of ['casUsername','casPassword'])$(id).addEventListener('input',updateAuthControls);
$('authForm').onsubmit=event=>{
  event.preventDefault();
  if(!$('authForm').reportValidity())return;
  return authAction('saveCredentials','正在保存…',async()=>{
    if(demo)throw new Error('请在 Chrome 插件中配置认证');
    const username=$('casUsername').value.trim(),password=$('casPassword').value;
    if(!username||!password)throw new Error('请填写校园账号和密码');
    try{
      if(!(await chrome.permissions.request({origins:[CAS_PERMISSION]})))throw new Error('未授权学校认证页面访问');
      await api({op:'saveCredentials',username,password});await refresh();note('账号已保存，自动登录已开启。');
    }finally{$('casPassword').value='';}
  });
};
for(const [op,label] of [['testLogin','正在检查…'],['openLogin','正在打开…'],['deleteCredentials','正在移除…']])$(op).onclick=()=>authAction(op,label,async()=>{
  await api({op});
  if(op==='deleteCredentials'){$('casUsername').value='';$('casPassword').value='';}
  await refresh();note(op==='openLogin'?'完成学校登录后，点击“立即检查”。':state.authStatus);
});
updateAuthControls();
$('feed').onclick=()=>run(async()=>{const r=await api({op:'feed'});$('feedURL').value=r.url;$('feedBox').hidden=false;});$('copyFeed').onclick=()=>run(async()=>{await navigator.clipboard.writeText($('feedURL').value);note('链接已复制，可以粘贴到日历软件的订阅中。');});
$('export').onclick=()=>{const list=activeAssignments();download('BBReader.ics',makeICS(list,state.account||'local'),'text/calendar;charset=utf-8');note(`已导出 ${list.filter(a=>a.due).length} 项带截止时间的作业。`);};
$('exportNotes').onclick=()=>{const notes=Object.entries(state.notes||{}).map(([url,n])=>`# ${state.courses.find(c=>c.id===n.courseId)?.name||''} / ${n.path.join(' / ')}\n\n${url}\n\n${n.items.map(i=>`## ${i.title}\n\n${i.body}\n\n${i.links.map(l=>`${l.title}: ${l.url}`).join('\n')}`).join('\n\n')}`).join('\n\n---\n\n');download('课程文字与链接.txt',notes||'尚无课程文字内容。','text/plain;charset=utf-8');};
$('reset').onclick=()=>run(async()=>{if(confirm('清空本地课程与作业索引？已归档的文件不会删除。')){await api({op:'reset'});courseDraft=null;await refresh();}});
// Appearance: palette + light/dark mode, stored per browser (see theme.js for first paint).
const THEMES=[['navy','墨蓝','默认 · 沉稳学院蓝','#1d5fbf','#e3edfa'],['indigo','靛蓝','现代 · 偏紫的蓝','#4f5bd5','#e8eafc'],['teal','青绿','原配色','#1f6f5c','#e3f0e8'],['terracotta','陶土','温暖 · 米色纸张','#c2562b','#fbe9df'],['graphite','石墨','极简 · 黑白灰','#18181b','#e9e9ec']];
function readTheme(){try{return JSON.parse(localStorage.getItem('bbreader-theme')||'{}');}catch{return {};}}
function applyTheme(t){
  const root=document.documentElement,palette=THEMES.some(x=>x[0]===t.palette)?t.palette:'navy',mode=['light','dark'].includes(t.mode)?t.mode:'auto';
  root.dataset.palette=palette;if(mode==='auto')delete root.dataset.mode;else root.dataset.mode=mode;
  document.querySelectorAll('[data-palette-option]').forEach(b=>b.setAttribute('aria-checked',String(b.dataset.paletteOption===palette)));
  document.querySelectorAll('[data-mode-option]').forEach(b=>{const on=b.dataset.modeOption===mode;b.classList.toggle('active',on);b.setAttribute('aria-checked',String(on));});
}
function saveTheme(change){const t={...readTheme(),...change};try{localStorage.setItem('bbreader-theme',JSON.stringify(t));}catch{}applyTheme(t);}
$('paletteOptions').replaceChildren(...THEMES.map(([id,name,hint,color,soft])=>{
  const b=el('button',undefined,'swatch-option'),chip=el('span',undefined,'chip'),text=el('span');
  b.type='button';b.dataset.paletteOption=id;b.setAttribute('role','radio');chip.style.background=color;chip.style.setProperty('--chip-soft',soft);
  text.append(name,el('small',hint));b.append(chip,text);b.onclick=()=>saveTheme({palette:id});return b;
}));
document.querySelectorAll('[data-mode-option]').forEach(b=>b.onclick=()=>saveTheme({mode:b.dataset.modeOption}));
window.addEventListener('storage',e=>{if(e.key==='bbreader-theme')applyTheme(readTheme());});
applyTheme(readTheme());
$('version').textContent=demo?'· 界面预览':`v${chrome.runtime.getManifest().version}`;
if(demo)$('preview').hidden=false;
showView(hashView());scrollTo(0,0);
await refresh();if(!demo)chrome.storage.onChanged.addListener(()=>refresh());
