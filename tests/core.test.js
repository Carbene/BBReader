import test from 'node:test';
import assert from 'node:assert/strict';
import {campusDay,dailyDue,nextNine,nextCheck,checkTime,parseDue,calendarDate,makeICS,readURL,cleanName} from '../extension/core.js';
test('09:00 campus time; one catch-up per day, independent of local timezone',()=>{
  const before=Date.parse('2026-09-26T08:59:00+08:00'),at=before+60000;
  assert.equal(dailyDue(undefined,before),false);assert.equal(dailyDue(undefined,at),true);
  assert.equal(dailyDue('2026-09-26',at+8*3600000),false);
  assert.equal(campusDay(Date.parse('2026-09-25T23:00:00Z')),'2026-09-26');
  assert.equal(nextNine(before),at);assert.equal(nextNine(at),at+86400000);
  assert.equal(dailyDue('2026-09-24',at+7*3600000),true);
});
test('English and Chinese deadlines preserve 23:59 and reject incomplete dates',()=>{
  assert.equal(parseDue('Sunday, September 27, 2026 11:59 PM'),'2026-09-27T15:59:00.000Z');
  assert.equal(parseDue('2026年9月27日 下午11:59'),'2026-09-27T15:59:00.000Z');
  assert.equal(parseDue('Oct 10, 2026 12:00 AM'),'2026-10-09T16:00:00.000Z');
  assert.equal(parseDue('Sep 27, 2026'),null);assert.equal(parseDue('2026-02-30 23:00'),null);
  assert.equal(parseDue('2026-09-27 25:00'),null);
  assert.equal(calendarDate('2026-09-27T23:59:00'),'2026-09-27T15:59:00.000Z');
});
test('only same-origin read endpoints and safe filenames',()=>{
  assert.throws(()=>readURL('https://evil.test/bbcswebdav/file'));
  assert.throws(()=>readURL('https://bb.sustech.edu.cn/webapps/login/?action=logout'));
  assert.throws(()=>readURL('https://bb.sustech.edu.cn/webapps/assignment/uploadAssignment?action=submit'));
  assert.equal(cleanName('../../danger/name.pdf'),'danger_name.pdf');assert.ok(!cleanName('a\\b/c').includes('/'));
});
test('ICS uses stable IDs, UTC, escaping, UTF-8 line folding, and no undated events',()=>{
  const a={id:'_1_1',courseId:'_2_1',courseName:'中文'.repeat(30),title:'A, B; C',due:'2026-09-27T15:59:00Z',url:'https://bb.sustech.edu.cn',status:'unknown'};
  const result=makeICS([a,{...a,due:null}], 'account',new Date('2026-09-26T00:00:00Z'));
  assert.equal(result.match(/BEGIN:VEVENT/g).length,1);assert.match(result,/DTSTART:20260927T155900Z/);
  assert.match(result,/UID:account-_2_1-_1_1@bbreader.local/);
  assert.match(result.replace(/\r\n /g,''),/A\\, B\\; C/);
  for(const line of result.split('\r\n'))assert.ok(Buffer.byteLength(line)<=75);
});

 test('attachment names retain server filenames and PDF extensions',async()=>{
  const {attachmentName}=await import('../extension/core.js');
  assert.equal(attachmentName("attachment; filename*=UTF-8''%E8%AF%BE%E4%BB%B6.pdf",'application/pdf','lecture'),'课件.pdf');
  assert.equal(attachmentName(null,'application/pdf','Lecture notes for week 2'),'Lecture notes for week 2.pdf');
  assert.equal(attachmentName(null,'application/vnd.openxmlformats-officedocument.presentationml.presentation','Lecture notes for week 2'),'Lecture notes for week 2.pptx');
  assert.equal(attachmentName('attachment; filename="lab.zip"','application/zip','Lab'),'lab.zip');
 });

test('archive names remove leading decorations and unsafe characters while retaining extensions',()=>{
  assert.equal(cleanName('--Lab Notes'),'Lab Notes');
  assert.equal(cleanName('  — • -- Week 1...  '),'Week 1');
  assert.equal(cleanName('--report?.pdf'),'report_.pdf');
  assert.equal(cleanName('CON.txt'),'_CON.txt');
  assert.equal(cleanName('...'),'未命名');
  assert.equal(cleanName('Lab-1_v2.pdf'),'Lab-1_v2.pdf');
});

test('locale name order changes preserve identity but different people do not match',async()=>{
  const {sameAccountLabel,browserFilename}=await import('../extension/core.js');
  assert.equal(sameAccountLabel('计算机 学院 李明(Li Ming)','李明(Li Ming) 计算机 学院','李明(Li Ming)'),true);
  assert.equal(sameAccountLabel('Computing Alice','Bob Computing','Bob'),false);
  assert.equal(sameAccountLabel('Computing Alice','Alice Physics','Alice'),false);
  assert.equal(sameAccountLabel('Alice Activity Updates 3','Alice'),true);
  const path=browserFilename(['Term','Course','Folder'.repeat(30),'课件'.repeat(90)+'.docx'],'win');
  assert.ok(path.length<=180);assert.ok(path.endsWith('.docx'));assert.equal(path.split('/').length,5);
  assert.equal(browserFilename(['--Lab','one.pdf'],'win'),'BBReader/Lab/one.pdf');
});

test('adjustable check time in campus time; invalid values fall back to 09:00',()=>{
  const t=Date.parse('2026-09-26T21:30:00+08:00');
  assert.equal(nextCheck(t-60000,'21:30'),t);assert.equal(nextCheck(t,'21:30'),t+86400000);
  assert.equal(dailyDue(undefined,t-60000,'21:30'),false);assert.equal(dailyDue(undefined,t,'21:30'),true);
  assert.equal(dailyDue('2026-09-26',t,'21:30'),false);
  assert.equal(nextCheck(Date.parse('2026-09-26T23:00:00+08:00'),'00:05'),Date.parse('2026-09-27T00:05:00+08:00'));
  for(const bad of ['24:00','9:00','09:60','x',undefined])assert.equal(checkTime(bad),'09:00');
  assert.equal(nextCheck(t,'bad'),nextNine(t));
});

test('an ignored file counts as handled: saved, matching a browser download, or explicitly ignored',async()=>{
  const {isIgnoredFile,isHandledFile}=await import('../extension/core.js');
  assert.equal(isIgnoredFile({ignored:true}),true);
  for(const value of [undefined,null,{},{ignored:false},{ignored:'yes'},{ignored:1}])assert.equal(isIgnoredFile(value),false);
  assert.equal(isHandledFile({ignored:true}),true);
  assert.equal(isHandledFile({savedPath:'/archive/Term/Course/lecture.pdf'}),true);
  assert.equal(isHandledFile({browserDownload:{id:0,path:'C:\\Downloads\\BBReader\\lecture.pdf'}}),true);
  assert.equal(isHandledFile({browserDownload:{}}),false);
  assert.equal(isHandledFile({}),false);
  assert.equal(isHandledFile(null),false);
  assert.equal(isHandledFile({ignored:false,error:'下载失败'}),false,'a failed download is not handled');
});
