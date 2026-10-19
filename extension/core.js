export const ORIGIN = 'https://bb.sustech.edu.cn';
export const PORTAL = `${ORIGIN}/webapps/portal/execute/tabs/tabAction?tab_tab_group_id=_1_1`;
export const DAY = 86400000;
// Campus deadlines and the daily check remain at UTC+8 when the laptop travels.
export function campusDay(now = Date.now()) { return new Date(now + 8 * 3600000).toISOString().slice(0, 10); }
// The daily check time is user-adjustable ("HH:MM", campus time); anything invalid falls back to 09:00.
export const DEFAULT_CHECK_TIME = '09:00';
export function checkTime(value) { return /^([01]\d|2[0-3]):[0-5]\d$/.test(value || '') ? value : DEFAULT_CHECK_TIME; }
export function checkToday(now = Date.now(), time) { return Date.parse(`${campusDay(now)}T${checkTime(time)}:00+08:00`); }
export function nextCheck(now = Date.now(), time) { const t = checkToday(now, time); return t > now ? t : t + DAY; }
export function dailyDue(lastDay, now = Date.now(), time) { return now >= checkToday(now, time) && lastDay !== campusDay(now); }
export const nineToday = now => checkToday(now);
export const nextNine = now => nextCheck(now);
// Files the user chose to ignore are treated as already handled: they never join a download
// batch and stay out of the file totals until the archive view reveals them again.
export const isIgnoredFile = file => file?.ignored === true;
export const isHandledFile = file => isIgnoredFile(file) || Boolean(file?.savedPath || file?.browserDownload?.path);
export function cleanName(s) {
  const value=String(s || '未命名').normalize('NFC').replace(/[\x00-\x1f\x7f/:\\<>"|?*]/g, '_').trim().replace(/^[\s._\-–—•·]+/, '').replace(/[.\s]+$/, '');
  const suffix=value.match(/\.[a-z0-9]{1,12}$/i)?.[0]||'',stem=value.slice(0,value.length-suffix.length);
  let result='';for(const c of stem){if(new TextEncoder().encode(result+c+suffix).length>180)break;result+=c;}result+=suffix;
  result=result.replace(/[.\s]+$/, '')||'未命名';
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(result)?`_${result}`:result;
}
export function sameAccountLabel(before,after,person='') {
  const clean=s=>String(s||'').replace(/(?:活动更新|Activity Updates).*$/i,'').replace(/\s+/g,' ').trim();
  const a=clean(before),b=clean(after),name=clean(person);
  if(a===b)return true;
  const other=s=>name&&s.startsWith(name+' ')?s.slice(name.length+1):name&&s.endsWith(' '+name)?s.slice(0,-name.length-1):null;
  return other(a)!==null&&other(a)===other(b);
}
export function browserFilename(relative,os) {
  const parts=['BBReader',...relative.map(cleanName)];
  if(os==='win'){
    const last=parts.length-1,ext=parts[last].match(/\.[a-z0-9]{1,12}$/i)?.[0]||'';
    // Leave room for a typical Windows user Downloads directory; retain the file extension.
    while(parts.join('/').length>180){
      const index=parts.map((p,i)=>i===0?-1:p.length-(i===last?ext.length:0)).reduce((best,n,i,all)=>n>all[best]?i:best,0);
      const suffix=index===last?ext:'';
      parts[index]=[...parts[index].slice(0,parts[index].length-suffix.length)].slice(0,-1).join('')+suffix;
    }
    return parts.map(cleanName).join('/');
  }
  return parts.join('/');
}
export function bbURL(value, base = ORIGIN) {
  try { const u = new URL(value, base); return u.origin === ORIGIN && !u.username && !u.password ? u : null; } catch { return null; }
}
export function readURL(value) {
  const u = bbURL(value);
  const paths = ['/webapps/blackboard/execute/launcher', '/webapps/blackboard/execute/courseMain',
    '/webapps/blackboard/execute/personalInfo',
    '/webapps/blackboard/content/listContent.jsp', '/webapps/blackboard/content/listContentEditable.jsp',
    '/webapps/assignment/uploadAssignment', '/webapps/bb-mygrades-BBLEARN/myGrades',
    '/webapps/calendar/calendarData/calendars', '/webapps/calendar/calendarData/events',
    '/webapps/calendar/calendarFeed/url'];
  if (!u || (!paths.includes(u.pathname) && !u.pathname.startsWith('/bbcswebdav/'))) throw new Error('拒绝读取非白名单地址');
  if (u.searchParams.has('action') || u.searchParams.has('method')) throw new Error('不允许带写入操作的地址');
  return u.href;
}
export async function digest(text) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(x => x.toString(16).padStart(2, '0')).join(''); }
export function parseDue(text) {
  const s = String(text).replace(/\s+/g, ' ').trim();
  let y, m, d;
  const cn = s.match(/(20\d{2})\s*(?:年|[-/])\s*(\d{1,2})\s*(?:月|[-/])\s*(\d{1,2})/);
  const en = s.match(/(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2}),?\s+(20\d{2})/i);
  if (cn) [, y, m, d] = cn.map(Number);
  else if (en) { y = +en[3]; m = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(en[1].slice(0,3).toLowerCase()) + 1; d = +en[2]; }
  else return null;
  const tm = s.match(/(?:(上午|下午)\s*)?(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM|上午|下午)?/i);
  if (!tm) return null; // A date alone is not an invented midnight deadline.
  let h = +tm[2]; const min = +tm[3], mer = (tm[1] || tm[4] || '').toUpperCase();
  if (mer && (h < 1 || h > 12)) return null;
  if (mer) h = h % 12 + (/PM|下午/.test(mer) ? 12 : 0);
  if (h > 23 || min > 59 || m < 1 || m > 12 || d < 1 || d > new Date(Date.UTC(y, m, 0)).getUTCDate()) return null;
  return new Date(Date.UTC(y, m - 1, d, h - 8, min)).toISOString();
}
export function calendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return null;
  const v = /(?:Z|[+-]\d\d:?\d\d)$/.test(value) ? value : `${value}+08:00`;
  return Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;
}
const escapeICS = s => String(s || '').replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
function fold(s) {
  let line = '', bytes = 0, result = [];
  for (const char of s) { const n = new TextEncoder().encode(char).length; if (bytes + n > 75) { result.push(line); line = ' '; bytes = 1; } line += char; bytes += n; }
  result.push(line); return result.join('\r\n');
}
export function makeICS(assignments, account, now = new Date()) {
  const stamp = d => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const rows = ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//BBReader//SUSTech//ZH','CALSCALE:GREGORIAN'];
  for (const a of assignments.filter(a => a.due && Number.isFinite(Date.parse(a.due)))) {
    rows.push('BEGIN:VEVENT', `UID:${escapeICS(account)}-${escapeICS(a.courseId)}-${escapeICS(a.id)}@bbreader.local`,
      `DTSTAMP:${stamp(now)}`, `DTSTART:${stamp(a.due)}`, `SUMMARY:${escapeICS(`${a.courseName} · ${a.title}`)}`,
      `DESCRIPTION:${escapeICS(`截止时间（校园时区 UTC+8）。状态：${a.status || 'unknown'}\n${a.description || ''}`)}`,
      `URL:${escapeICS(a.url)}`, 'TRANSP:TRANSPARENT','END:VEVENT');
  }
  return rows.concat('END:VCALENDAR').map(fold).join('\r\n') + '\r\n';
}

export function attachmentName(disposition, type, fallback) {
  let name;
  const encoded=disposition?.match(/filename\*\s*=\s*UTF-8''([^;]+)/i)?.[1];
  if(encoded){try{name=decodeURIComponent(encoded.trim());}catch{}}
  name ||= disposition?.match(/filename\s*=\s*"([^"]+)"/i)?.[1] || disposition?.match(/filename\s*=\s*([^;]+)/i)?.[1]?.trim() || fallback;
  if(!/\.[a-z0-9]{1,8}$/i.test(name)) {
    const ext={'application/pdf':'.pdf','application/zip':'.zip','image/jpeg':'.jpg','image/png':'.png','application/vnd.openxmlformats-officedocument.presentationml.presentation':'.pptx','application/vnd.openxmlformats-officedocument.wordprocessingml.document':'.docx','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':'.xlsx'}[type?.split(';')[0]?.trim()];
    if(ext)name+=ext;
  }
  return cleanName(name);
}
