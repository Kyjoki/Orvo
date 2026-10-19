import {readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const origin=process.env.ORVO_RUNTIME_URL||'http://127.0.0.1:3000';
const health=await fetch(`${origin}/api/health`).then(r=>r.json());
assert.equal(health.testMode,true,'File smoke is allowed only in explicit local test mode');
const access=JSON.parse(await readFile('.orvo/test-access.json','utf8'));
const login=await fetch(`${origin}/api/auth/sign-in/email`,{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(access)});
assert.equal(login.status,200);
const cookie=login.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');
const headers={cookie,origin,'content-type':'application/json'};
async function upload(name:string,text:string){
 const registered=await fetch(`${origin}/api/files`,{method:'POST',headers,body:JSON.stringify({name,size:Buffer.byteLength(text)})});
 assert.equal(registered.status,200);const data=await registered.json();
 const put=await fetch(`${origin}${data.uploadUrl}`,{method:'PUT',headers:{cookie,origin,...data.headers},body:text});assert.equal(put.status,200);
 const completed=await fetch(`${origin}/api/files`,{method:'POST',headers,body:JSON.stringify({type:'complete',id:data.id})});
 return {id:data.id,response:completed,data:await completed.json()};
}
const checks:string[]=[];
assert.equal((await fetch(`${origin}/api/state`)).status,401);checks.push('unauthenticated snapshot blocked');
assert.equal((await fetch(`${origin}/api/files`,{method:'POST',headers:{cookie,'content-type':'application/json'},body:'{}'})).status,403);checks.push('foreign origin blocked');
const text='# Test document\nPrivate local attachment with a clear expected result.';
const file=await upload('[TEST] requirements.md',text);assert.equal(file.response.status,200);assert.equal(file.data.attachment.text,text);
const download=await fetch(`${origin}/api/files/${file.id}`,{headers:{cookie}});assert.equal(await download.text(),text);checks.push('private Markdown upload, extraction and download');
assert.equal((await fetch(`${origin}/api/files/${file.id}`)).status,401);checks.push('private download needs owner');
const binary=await upload('[TEST] invalid.pdf','This is not a PDF document');assert.equal(binary.data.error.code,'INVALID_PDF');checks.push('false PDF rejected');
function testPdf(content:string){
 const stream=`BT /F1 12 Tf 72 720 Td (${content}) Tj ET`;
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
 let pdf='%PDF-1.4\n';const offsets=[0];objects.forEach((obj,i)=>{offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${obj}\nendobj\n`;});const xref=Buffer.byteLength(pdf);pdf+=`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(v=>`${String(v).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;return pdf;
}
const pdf=await upload('[TEST] document.pdf',testPdf('Orvo private PDF extraction acceptance test.'));assert.equal(pdf.response.status,200);assert.match(pdf.data.attachment.text,/Orvo private PDF/);checks.push('real PDF text extraction');
const long=await upload('[TEST] oversized-text.txt','a'.repeat(50001));assert.equal(long.data.error.code,'EXTRACTED_TEXT_LIMIT');checks.push('extracted text limit enforced');
// Harmless synthetic marker, never a real credential.
const secret=await upload('[TEST] secret-marker.txt','api_key=synthetic_test_marker');assert.equal(secret.data.error.code,'SECRET_REJECTED');checks.push('synthetic secret marker rejected');
const tooBig=await fetch(`${origin}/api/files`,{method:'POST',headers,body:JSON.stringify({name:'large.txt',size:10*1024*1024+1})});assert.equal(tooBig.status,400);checks.push('10 MiB maximum enforced');
await writeFile('.orvo/files-smoke-report.json',JSON.stringify({at:new Date().toISOString(),checks},null,2));
for(const check of checks)console.log(`PASS ${check}`);
