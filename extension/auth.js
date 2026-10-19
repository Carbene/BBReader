import {ORIGIN,campusDay} from './core.js';
export const CAS_PERMISSION='https://cas.sustech.edu.cn/*';
export const SSO=ORIGIN+'/webapps/bb-sso-BBLEARN/index.jsp';
// Runs only in the top-level page. Validate both destination and form before filling.
export function casForm(credentials) {
  const u=new URL(location.href);
  if(u.origin!=='https://cas.sustech.edu.cn'||u.pathname!=='/cas/login'||u.searchParams.get('service')!=='https://bb.sustech.edu.cn/webapps/bb-sso-BBLEARN/index.jsp')return 'wrong-page';
  if(/Invalid credentials\.|用户名或密码错误/.test(document.body?.innerText||''))return 'rejected';
  const form=document.querySelector('form#fm1'),user=form?.querySelector('input[name=username]'),pass=form?.querySelector('input[name=password]');
  if(!form||!user||!pass)return 'manual';
  const action=new URL(form.getAttribute('action')||location.href,location.href);
  if(action.origin!==u.origin||action.pathname!==u.pathname||form.method.toLowerCase()!=='post')return 'manual';
  if(document.querySelector('.alert-danger,#msg.errors,.captcha-panel input'))return 'manual';
  if(!credentials)return 'ready';
  user.value=credentials.username;pass.value=credentials.password;
  user.dispatchEvent(new Event('input',{bubbles:true}));pass.dispatchEvent(new Event('input',{bubbles:true}));
  form.requestSubmit();return 'submitted';
}
// Navigation failures are distinct from a rejected password; never expose Chrome's raw errors.
export function loginError(error) {
  const message=String(error?.message||error);
  if(/No tab with id/i.test(message))return new Error('学校登录页面已关闭，请重新点击“检查连接”');
  if(/showing error page/i.test(message))return new Error('学校页面加载失败，请检查校园网络连接后重试');
  return error;
}
export const navigationFailure=error=>/showing error page|frame.*removed|frame.*not found|document.*unloaded/i.test(error?.message||'');
// Browser mode uses the encrypted browser vault (browserCredentialLogin); macOS integration uses the Keychain (credentialLogin).
export async function renewLogin({native,get,put,manual=false,readCredentials=()=>native({op:'readCredentials'})}) {
  const s=await get(),saved=s.integrationMode==='browser'?s.browserCredentialLogin===true:s.credentialLogin===true;
  const canFill=saved&&(manual||!s.authBlocked&&s.lastCredentialDay!==campusDay());
  const permitted=await chrome.permissions.contains({origins:[CAS_PERMISSION]});
  // Check the existing SSO session first; manual allows one password retry only if needed.
  const url=SSO;
  const tab=await chrome.tabs.create({url,active:manual});let keep=manual,submitted=false;
  try {
    const deadline=Date.now()+25000;
    while(Date.now()<deadline) {
      const current=await chrome.tabs.get(tab.id);
      if(current.status!=='complete'){await new Promise(r=>setTimeout(r,300));continue;}
      if(current.url?.startsWith(ORIGIN+'/')) {
        const [{result}]=await chrome.scripting.executeScript({target:{tabId:tab.id},func:()=>!!document.querySelector('#global-nav-link')});
        if(result){keep=false;const latest=await get();if(submitted||manual)latest.authBlocked=false;latest.authStatus=submitted?'已使用保存的凭据自动登录 Blackboard':'统一认证连接正常';await put(latest);return;}
      } else {
        if(!permitted||!canFill)throw new Error('需要在学校统一认证页面登录，完成后点击“立即检查”');
        const [{result}]=await chrome.scripting.executeScript({target:{tabId:tab.id},func:casForm,args:[null]});
        if(result==='rejected')throw new Error('学校拒绝了登录凭据，请核对校园账号和密码后重新保存；已暂停密码重试');
        if(!submitted) {
          if(result!=='ready')throw new Error('统一认证需要手动处理，请打开学校登录页');
          const latest=await get();latest.lastCredentialDay=campusDay();await put(latest);
          const credentials=await readCredentials();
          if(!credentials.configured)throw new Error('尚未配置统一认证凭据');
          try {
            const [{result:sent}]=await chrome.scripting.executeScript({target:{tabId:tab.id},func:casForm,args:[{username:credentials.username,password:credentials.password}]});
            if(sent!=='submitted')throw new Error('认证页面发生变化，请手动登录');
            submitted=true;
          } finally {credentials.password='';credentials.username='';}
        }
      }
      await new Promise(r=>setTimeout(r,500));
    }
    throw new Error('统一认证未完成，可能需要验证码或重新输入密码；已暂停密码重试，请打开学校登录页');
  } catch(e) {
    const failure=loginError(e);
    const latest=await get();if(submitted)latest.authBlocked=true;latest.authStatus=failure.message;await put(latest);throw failure;
  } finally {if(!keep)await chrome.tabs.remove(tab.id).catch(()=>{});}
}
