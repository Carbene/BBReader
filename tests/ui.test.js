import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const uiSource=()=>readFileSync(new URL('../extension/ui.js',import.meta.url),'utf8');

test('credential form validates input, locks concurrent actions, clears passwords, and recovers after errors',async()=>{
  const elements=Object.fromEntries(['authForm','casUsername','casPassword','saveCredentials','testLogin','openLogin','deleteCredentials'].map(id=>[id,{value:'',textContent:id,disabled:false,attributes:{},addEventListener(type,fn){this[type]=fn;},setAttribute(k,v){this.attributes[k]=v;},reportValidity(){return true;}}]));
  let finish,calls=0,message='';
  const context=vm.createContext({authBusy:false,demo:false,state:{authStatus:'Connected'},CAS_PERMISSION:'https://cas.sustech.edu.cn/*',$:id=>elements[id],chrome:{permissions:{request:async()=>true}},api:async()=>{calls++;await new Promise(resolve=>finish=resolve);},refresh:async()=>{},note:text=>message=text,run:async fn=>{try{await fn();}catch(e){message=e.message;}}});
  const source=uiSource();
  vm.runInContext(source.slice(source.indexOf('function updateAuthControls()'),source.indexOf("$('feed').onclick")),context);
  assert.equal(elements.saveCredentials.disabled,true);
  elements.casUsername.value='test-sid';elements.casUsername.input();
  assert.equal(elements.saveCredentials.disabled,true);
  elements.casPassword.value='test-only';elements.casPassword.input();
  assert.equal(elements.saveCredentials.disabled,false);
  const pending=elements.authForm.onsubmit({preventDefault(){}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(elements.authForm.attributes['aria-busy'],'true');
  for(const id of ['casUsername','casPassword','saveCredentials','testLogin','openLogin','deleteCredentials'])assert.equal(elements[id].disabled,true,id);
  await elements.testLogin.onclick();assert.equal(calls,1);
  finish();await pending;
  assert.equal(elements.casPassword.value,'');assert.equal(elements.saveCredentials.disabled,true);
  assert.equal(elements.testLogin.disabled,false);assert.equal(elements.authForm.attributes['aria-busy'],'false');
  context.api=async()=>{throw Error('Connection failed');};
  elements.casPassword.value='test-only';elements.casPassword.input();
  await elements.authForm.onsubmit({preventDefault(){}});
  assert.equal(message,'Connection failed');assert.equal(elements.casPassword.value,'');assert.equal(elements.casUsername.disabled,false);
});

// The archive view is the largest renderer in ui.js and had no coverage: a stray identifier there
// fails only in a real browser. Running the extracted renderer catches that class of mistake.
function fileView(){
  const ids=['fileSummary','fileSearch','selectVisibleFiles','clearFileSelection','downloadSelected','downloadAll','ignoreSelected','unignoreSelected','toggleIgnoredFiles','downloadStatus','fileList','cancelDownloads','stopDownloads','resumeDownloads','sync'];
  const elements=Object.fromEntries(ids.map(id=>[id,{id,textContent:'',hidden:false,disabled:false,dataset:{},attributes:{},children:[],replaceChildren(...nodes){this.children=nodes;},append(...nodes){this.children.push(...nodes);},setAttribute(k,v){this.attributes[k]=v;},addEventListener(){}}]));
  const document={createElement:tag=>({tag,className:'',children:[],textContent:'',dataset:{},style:{setProperty(){}},setAttribute(k,v){this[k]=v;},append(...nodes){this.children.push(...nodes);},get firstElementChild(){return this.children[0]||null;}}),getElementById:id=>elements[id]||null};
  const source=uiSource();
  // Start at activeFiles: renderFiles() calls it, and it sits directly above allFiles().
  const start=source.indexOf('const activeFiles='),end=source.indexOf('function render(){');
  assert.ok(start>0&&end>start,'the archive renderer is sliceable for testing');
  const context=vm.createContext({
    document,$:id=>elements[id],state:{},downloadQueue:{items:[],batches:[],stopped:false},fileQuery:'',fileShowIgnored:false,selectedFiles:new Set(),collapsedGroups:new Set(),
    note:()=>{},refresh:async()=>{},api:async()=>({ok:true}),run:async fn=>fn(),
    // activeFiles()/allFiles() call these imported or earlier-defined helpers; the slice omits them.
    isIgnoredFile:file=>file?.ignored===true,
    enabledCourse:id=>context.state.courses.some(c=>c.id===id&&c.enabled),
    el(tag,txt,cls){const e=document.createElement(tag);if(txt!==undefined&&txt!==null)e.textContent=txt;if(cls)e.className=cls;return e;},
    link(title,url){const a=document.createElement('a');a.textContent=title;a.href=url;return a;},
    courseColor:()=>'#2f7d6d'
  });
  vm.runInContext(source.slice(start,end),context);
  return {context,elements};
}
test('the archive renderer handles saved, paused, failed, and ignored files without throwing',()=>{
  const {context,elements}=fileView();
  context.state={integrationMode:'browser',job:null,courses:[{id:'_1_1',name:'Course',enabled:true}],files:{
    '_1_1:a':{key:'_1_1:a',courseId:'_1_1',name:'saved.pdf',url:'https://bb.sustech.edu.cn',browserDownload:{path:'C:\\Downloads\\BBReader\\saved.pdf'}},
    '_1_1:b':{key:'_1_1:b',courseId:'_1_1',name:'paused.pdf',url:'https://bb.sustech.edu.cn'},
    '_1_1:c':{key:'_1_1:c',courseId:'_1_1',name:'failed.pdf',url:'https://bb.sustech.edu.cn',error:'用户取消下载'},
    '_1_1:d':{key:'_1_1:d',courseId:'_1_1',name:'ignored.pdf',url:'https://bb.sustech.edu.cn',ignored:true}
  }};
  context.downloadQueue={stopped:true,stopping:false,batches:[{id:'b1',status:'complete'}],items:[{key:'_1_1:b',batchId:'b1',status:'cancelled'},{key:'_1_1:c',batchId:'b1',status:'failed'}]};
  context.renderFiles();
  assert.match(elements.fileSummary.children.map(s=>s.textContent).join(' | '),/共 3 份/);
  assert.match(elements.fileSummary.children.map(s=>s.textContent).join(' | '),/已忽略 1/);
  assert.match(elements.downloadStatus.textContent,/下载已暂停：还有 1 个未完成的课件/);
  // Errors keep their own red styling; ignored files start hidden.
  const text=nodes=>nodes.flatMap(n=>n.children?text(n.children):[]).concat(nodes.map(n=>n.textContent||'').filter(Boolean));
  const all=text(elements.fileList.children);
  assert.ok(all.includes('saved.pdf')&&all.includes('paused.pdf')&&all.includes('failed.pdf'),'enabled-course files are listed');
  assert.ok(!all.includes('ignored.pdf'),'ignored files stay hidden until they are revealed');
  assert.ok(all.includes('用户取消下载'),'the failure reason is rendered');
  // A download error is drawn in the red style; a paused file only gets the muted one.
  // Rows are <div class=file>[checkbox, state dot, <div><strong>name</strong><small>reason</small></div>, …].
  const smallOf=name=>elements.fileList.children.flatMap(group=>group.children).map(row=>row.children[2]).find(cell=>cell?.children?.[0]?.textContent===name)?.children?.[1];
  assert.match(smallOf('failed.pdf').className,/err/,'a failed download is marked as an error');
  assert.doesNotMatch(smallOf('paused.pdf').className,/err/,'a paused download is not an error');
  // Revealing ignored files lists them with the short label only.
  context.fileShowIgnored=true;context.renderFiles();
  const revealed=text(elements.fileList.children);
  assert.ok(revealed.includes('ignored.pdf'),'revealing ignored files lists them');
  assert.ok(revealed.includes('已忽略'),'the ignored state uses the short label');
  assert.ok(!revealed.includes('按已下载处理'),'the removed parenthetical is gone');
  // The two ignore actions follow what is actually selected: live files can be ignored, files that
  // are already ignored can be un-ignored. Neither may appear for the other kind of selection.
  assert.equal(elements.ignoreSelected.hidden,false,'with nothing selected the ignore action stays available');
  assert.equal(elements.ignoreSelected.disabled,true,'but is disabled without a selection');
  assert.equal(elements.ignoreSelected.textContent,'忽略所选','no count is claimed without a selection');
  assert.equal(elements.unignoreSelected.hidden,true,'and offers no un-ignore');
  context.selectedFiles.add('_1_1:a');context.renderFiles();
  assert.equal(elements.unignoreSelected.hidden,true,'selecting a live file must not offer un-ignore');
  assert.equal(elements.ignoreSelected.hidden,false);
  assert.match(elements.ignoreSelected.textContent,/忽略所选（1）/);
  context.selectedFiles.clear();context.selectedFiles.add('_1_1:d');
  context.renderFiles();
  assert.equal(elements.unignoreSelected.hidden,false,'selecting an ignored file offers un-ignore');
  assert.match(elements.unignoreSelected.textContent,/取消忽略所选（1）/);
  assert.equal(elements.ignoreSelected.hidden,true,'an ignored file is not a downloadable selection');
  assert.match(elements.downloadSelected.textContent,/下载所选（0）/,'ignored files are not downloadable selections');
  context.selectedFiles.clear();context.renderFiles();
});
