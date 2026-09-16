import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {seal} from '../src/security.js';
import {planMinuteAppend} from '../src/minute-plan.js';
import {minuteFixture} from './minute-fixture.js';

const device='1234567890ABCDEF',day='2026-09-16',noon=Date.parse(day+'T12:00:00+08:00');
const row=(stride=3)=>({uid:'A',date:day,device_id:device,source:58,data:minuteFixture(125,stride),summary:{stp:{ttl:8472},other:'preserve'}});
test('minute append preserves all other bytes, metadata and higher summary, for 3/8 byte records',()=>{
 for(const stride of [3,8]){
  const input=row(stride),before=Buffer.from(input.data,'base64');
  if(stride===8){before[719*stride+7]=9;input.data=before.toString('base64');}
  const p=planMinuteAppend(input,device,day,noon),after=Buffer.from(p.row.data[0].value,'base64');
  assert.equal(p.expectedDetail,365);assert.equal(p.expectedSummary,8472);assert.equal(JSON.parse(p.row.summary).other,'preserve');
  assert.deepEqual(p.minutes,stride===3?[718,719]:[717,718]);
  for(let i=0;i<before.length;i++)if(!p.minutes.some(m=>i>=m*stride&&i<m*stride+3))assert.equal(after[i],before[i]);
  assert.equal(input.summary.stp.ttl,8472);
 }
});
test('append refuses cross-day, mismatched device, merged ambiguity, missing baseline and over-limit',()=>{
 assert.throws(()=>planMinuteAppend(row(),device,day,noon+86400000));
 assert.throws(()=>planMinuteAppend(row(),'ABCDEF123456',day,noon));
 assert.throws(()=>planMinuteAppend({...row(),mergedRawData:minuteFixture(126)},device,day,noon));
 assert.throws(()=>planMinuteAppend({...row(),data:''},device,day,noon));
 assert.throws(()=>planMinuteAppend({...row(),summary:{stp:{ttl:50001}}},device,day,noon));
 assert.throws(()=>planMinuteAppend(row(),device,day,Date.parse(day+'T00:01:00+08:00')));
});

test('workerd lab: auth, CSRF, isolation, lease, read-only, exact append, durable duplicate and uncertain POST protection',{timeout:30000},async()=>{
 const now=Math.floor(Date.now()/1000),today=new Date(Date.now()+28800000).toISOString().slice(0,10);
 // The runtime fixture is useful except in the first two minutes of the Beijing day.
 const elapsed=(Date.now()+28800000)%86400000;if(elapsed<120000)return;
 let reads=0,posts=0,binds=0,tokenValid=true,foreign=false,uncertain=false,baselineChanged=false;
 let data={...row(),date:today},devices=[{uid:'A',deviceid:device,device_type:0,activeStatus:0,productId:61}];
 const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'app',modules:true,script:readFileSync(new URL('../dist/worker.js',import.meta.url),'utf8'),compatibilityDate:'2026-09-15',compatibilityFlags:['nodejs_compat'],bindings:{APP_ORIGIN:'https://local.test',MASTER_SECRET:'lab-test-only'},d1Databases:['DB'],
  outboundService:async req=>{
   const url=new URL(req.url);reads++;
   if(url.pathname.includes('getUserInfo.json'))return tokenValid?Response.json({message:'success'}):new Response('{}',{status:401});
   if(url.pathname.endsWith('/lists.json'))return Response.json({code:1,data:foreign?[{...devices[0],uid:'someone-else'}]:devices});
   if(url.pathname.endsWith('/binds.json')){
    binds++;const body=new URLSearchParams(await req.text());assert.equal(body.get('activeStatus'),'0');
    devices=[{uid:'A',device_type:0,deviceid:body.get('deviceid'),activeStatus:0}];
    return Response.json({code:1});
   }
   if(url.pathname.endsWith('/band_data.json')){
    if(req.method==='POST'){
     posts++;if(uncertain)return new Response('uncertain',{status:500});
     const body=new URLSearchParams(await req.text()),payload=JSON.parse(body.get('data_json'))[0];
     assert.equal(body.get('last_deviceid'),device);assert.ok(Number(body.get('last_sync_data_time'))>=now);
     data={...data,data:payload.data[0].value,summary:JSON.parse(payload.summary)};
     return Response.json({message:'success'});
    }
    if(baselineChanged)data={...data,uuid:crypto.randomUUID()};
    return Response.json({message:'success',data:[data]});
   }
   throw Error('Unexpected login or outbound request: '+url.pathname);
  }
 }]}));
 try{
  const db=await mf.getD1Database('DB'),schema=new DatabaseSync(':memory:');
  for(const name of readdirSync(new URL('../migrations/',import.meta.url)).filter(n=>n.endsWith('.sql')).sort())schema.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
  for(const {sql} of schema.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all())await db.prepare(sql).run();schema.close();
  for(const id of ['A','B']){
   await db.prepare('INSERT INTO accounts(id,label,credentials,enabled,session_version,created_at,updated_at) VALUES(?,?,?,0,?,?,?)').bind(id,id,await seal({user_id:id,app_token:'test'},'lab-test-only','zepp:'+id),'v',now,now).run();
   await db.prepare('INSERT INTO memberships(account_id,expires_at,created_at,updated_at) VALUES(?,?,?,?)').bind(id,now+86400,now,now).run();
  }
  const cookie=await seal({id:'A',version:'v',csrf:'csrf',exp:now+86400},'lab-test-only','user-session-v2');
  const call=async(kind,body={},extra={})=>mf.dispatchFetch('https://local.test/api/sync-lab'+(kind?'/'+kind:''),{method:kind?'POST':'GET',headers:{cookie:'__Host-mimotion-user-v2='+cookie,Origin:'https://local.test','content-type':'application/json','X-CSRF-Token':'csrf',...extra},...(kind?{body:JSON.stringify(body)}:{})});
  const resetLimit=()=>db.prepare('DELETE FROM rate_limits').run();
  assert.equal((await call('inspect',{}, {cookie:''})).status,401);
  assert.equal((await call('inspect',{}, {'X-CSRF-Token':'wrong'})).status,403);
  assert.equal((await call('bind')).status,400);assert.equal(reads,0);
  await db.prepare("UPDATE memberships SET expires_at=0 WHERE account_id='A'").run();
  assert.equal((await call('inspect')).status,403);assert.equal(reads,0);
  await db.prepare("UPDATE memberships SET expires_at=? WHERE account_id='A'").bind(now+86400).run();
  await db.prepare("UPDATE accounts SET lease_id='other',lease_until=? WHERE id='A'").bind(now+600).run();
  assert.equal((await call('inspect')).status,409);assert.equal(reads,0);
  await db.prepare("UPDATE accounts SET lease_id=NULL,lease_until=0 WHERE id='A'").run();
  const inspected=await (await call('inspect')).json();assert.equal(inspected.evidence.detail,125);assert.equal(inspected.evidence.state,'inconsistent');assert.equal(posts+binds,0);
  await resetLimit();assert.equal((await call('bind',{confirm:true})).status,409);assert.equal(binds,0);
  foreign=true;assert.equal((await call('append',{confirm:true})).status,502);assert.equal(posts,0);foreign=false;
  baselineChanged=true;assert.equal((await call('append',{confirm:true})).status,409);assert.equal(posts,0);baselineChanged=false;
  await resetLimit();const appended=await (await call('append',{confirm:true})).json();assert.equal(appended.status,'verified');assert.equal(appended.evidence.detail,365);assert.equal(posts,1);
  assert.equal((await call('append',{confirm:true})).status,409);assert.equal(posts,1);
  const history=await (await call()).json();assert.ok(history.append_claimed);assert.ok(history.records.length);const beforeReads=reads;await call();assert.equal(reads,beforeReads);
  const cookieB=await seal({id:'B',version:'v',csrf:'csrf',exp:now+86400},'lab-test-only','user-session-v2');
  assert.equal((await (await call('',{}, {cookie:'__Host-mimotion-user-v2='+cookieB})).json()).records.length,0);
  await resetLimit();tokenValid=false;assert.equal((await call('inspect')).status,401);tokenValid=true;
  // Test a fresh day claim without advancing the clock; the deletion is TEST-ONLY.
  await db.prepare("DELETE FROM sync_lab_claims WHERE slot LIKE 'append:%'").run();uncertain=true;
  assert.equal((await call('append',{confirm:true})).status,502);assert.equal(posts,2);
  await resetLimit();assert.equal((await call('append',{confirm:true})).status,409);assert.equal(posts,2);
  devices=[];assert.equal((await call('bind',{confirm:true})).status,200);assert.equal(binds,1);
  devices=[];await resetLimit();assert.equal((await call('bind',{confirm:true})).status,409);assert.equal(binds,1);
  assert.equal((await db.prepare("SELECT lease_until FROM accounts WHERE id='A'").first()).lease_until,0);
  await db.prepare("DELETE FROM accounts WHERE id='A'").run();
  assert.equal((await db.prepare("SELECT count(*) n FROM sync_lab_operations WHERE account_id='A'").first()).n,0);
  assert.equal((await db.prepare("SELECT count(*) n FROM sync_lab_claims WHERE account_id='A'").first()).n,2);
 }finally{await mf.dispose();}
});
