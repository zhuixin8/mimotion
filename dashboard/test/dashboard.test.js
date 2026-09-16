import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import worker from '../dist/worker.js';
import {seal,open,fetchJSON} from '../src/security.js';
import {loginZepp,validate} from '../src/zepp.js';
import {connectionCheck} from '../dist/worker.js';
const origin='https://mimotion.test';
const time=()=>Math.floor(Date.now()/1000);
const day=()=>new Date(Date.now()+28800000).toISOString().slice(0,10);

test('0105 recovery verifies identity, persists credentials and submits only once',async(t)=>{
 for(const type of [undefined,'huami_phone']){
  const env=environment();await account(env,'A');addRun(env,'recover','A');
  const old=await open(env.db.prepare('SELECT credentials FROM accounts').get().credentials,env.MASTER_SECRET,'zepp:A');
  Object.assign(old,{access_token:'dummy-access',device_id:'dummy-device',login_type:type});
  env.db.prepare('UPDATE accounts SET credentials=?').run(await seal(old,env.MASTER_SECRET,'zepp:A'));
  const mock=zeppMock(t,{userId:'A'}),normal=globalThis.fetch;let grants=0;
  t.mock.method(globalThis,'fetch',async(url,opts)=>{
   if(String(url).includes('/app_tokens'))return Response.json({error_code:'0105'});
   if(String(url).includes('/v2/client/login')){grants++;assert.equal(opts.body.get('third_name'),type||'email');assert.equal(opts.body.get('allow_registration'),'false');}
   return normal(url,opts);
  });
  await consume(env,msg('recover'));
  assert.equal(grants,1);assert.equal(env.db.prepare('SELECT status FROM runs').get().status,'success');
  assert.equal(mock.calls.filter(c=>c.url.includes('/band_data')&&c.opts.method==='POST').length,1);
  const row=env.db.prepare('SELECT * FROM accounts').get(),fresh=await open(row.credentials,env.MASTER_SECRET,'zepp:A');
  assert.equal(fresh.app_token,'app-token');assert.equal(fresh.login_token,'login-token');assert.equal(fresh.login_type,type||'email');assert.equal(row.needs_login,0);assert.equal(row.enabled,1);
 }
});

test('failed recovery never submits or stores partial or mismatched credentials',async(t)=>{
 for(const scenario of ['mismatch','incomplete','rejected','outage','missing-access']){
  const env=environment();await account(env,'A');addRun(env,'recover','A');
  const old=await open(env.db.prepare('SELECT credentials FROM accounts').get().credentials,env.MASTER_SECRET,'zepp:A');
  if(scenario!=='missing-access')Object.assign(old,{access_token:'dummy-access',device_id:'dummy-device'});
  const sealed=await seal(old,env.MASTER_SECRET,'zepp:A');env.db.prepare('UPDATE accounts SET credentials=?').run(sealed);
  const mock=zeppMock(t),normal=globalThis.fetch;let grants=0;
  t.mock.method(globalThis,'fetch',async(url,opts)=>{
   if(String(url).includes('/app_tokens'))return Response.json({error_code:'0105'});
   if(String(url).includes('/v2/client/login')){
    grants++;
    if(scenario==='outage')return Response.json({message:'unavailable'},{status:503});
    if(scenario==='rejected')return Response.json({result:'fail'},{status:401});
    return Response.json({result:'ok',token_info:{user_id:'B',app_token:'partial',...(scenario==='mismatch'?{login_token:'wrong-user'}:{})}});
   }
   return normal(url,opts);
  });
  await consume(env,msg('recover'));
  assert.equal(grants,scenario==='missing-access'?0:1);assert.equal(mock.calls.filter(c=>c.url.includes('/band_data')&&c.opts.method==='POST').length,0);
  const row=env.db.prepare('SELECT * FROM accounts').get();assert.equal(row.credentials,sealed);
  assert.equal(row.needs_login,['mismatch','rejected','missing-access'].includes(scenario)?1:0,scenario);
 }
});
test('login during a running read-only check reuses it and old work cannot overwrite renewed credentials',async(t)=>{
 for(const fail of [false,true]){
  const env=environment();const mock=zeppMock(t);env.db.prepare('UPDATE site_settings SET new_user_gift_days=7').run();
  const input={account:'running@example.com',password:'dummy',consent:true,min_step:1,max_step:2};const first=await (await api(env,'/api/login',input)).json();
  const normal=globalThis.fetch;let release,started;const gate=new Promise(r=>release=r),ready=new Promise(r=>started=r);
  t.mock.method(globalThis,'fetch',async(url,opts)=>{if(String(url).includes('/app_tokens')){started();await gate;return fail?Response.json({result:'fail'},{status:401}):Response.json({result:'ok',token_info:{app_token:'stale-job-token'}});}return normal(url,opts);});
  const running=consume(env,msg(first.check.id));await ready;
  try{
   const res=await api(env,'/api/login',input);assert.equal(res.status,200);const data=await res.json();assert.equal(data.check.state,'running');assert.equal(data.check.id,first.check.id);
  }finally{release();await running;}
  const accountRow=env.db.prepare('SELECT * FROM accounts').get(),tokens=await open(accountRow.credentials,env.MASTER_SECRET,'zepp:'+accountRow.id);
  assert.equal(tokens.app_token,'app-token');assert.equal(accountRow.needs_login,0);assert.equal(env.db.prepare('SELECT COUNT(*) n FROM runs').get().n,1);
  assert.equal(mock.calls.filter(c=>c.url.includes('/band_data')&&c.opts.method==='POST').length,0);
 }
});
test('login reuses recent success; credential recovery and manual checks bypass that cache',async(t)=>{
 const env=environment(),mock=zeppMock(t);env.db.prepare('UPDATE site_settings SET new_user_gift_days=7').run();
 const input={account:'cache@example.com',password:'dummy',consent:true,min_step:1,max_step:2};
 const first=await api(env,'/api/login',input);assert.equal(first.status,200);const a=await first.json();assert.equal(a.check.state,'queued');assert.equal(a.check.reused,false);
 await consume(env,msg(a.check.id));const second=await api(env,'/api/login',input),b=await second.json();assert.equal(b.check.state,'cached');assert.equal(b.check.id,a.check.id);assert.ok(b.check.checked_at);
 assert.equal(env.db.prepare("SELECT COUNT(*) n FROM runs WHERE kind='check'").get().n,1);
 assert.equal(mock.calls.filter(c=>c.url.includes('/registrations/tokens')).length,2);
 env.db.prepare('UPDATE accounts SET needs_login=1').run();
 const recovered=await api(env,'/api/login',input),c=await recovered.json();assert.equal(c.check.state,'queued');assert.notEqual(c.check.id,a.check.id);await consume(env,msg(c.check.id));
 const cookie=recovered.headers.get('set-cookie').split(';')[0],s=await (await api(env,'/api/status',undefined,{cookie})).json(),session={cookie,csrf:s.csrf};
 const manual=await api(env,'/api/check',{},session);assert.equal(manual.status,202);const m=await manual.json();assert.equal(m.check.state,'queued');assert.notEqual(m.id,c.check.id);
 assert.equal((await api(env,'/api/check',{},session)).status,429);assert.equal(mock.calls.filter(c=>c.url.includes('/band_data')&&c.opts.method==='POST').length,0);
});
test('connection cache expires at 30 minutes, rejects prior-day readings and honors the latest failure',async()=>{
 for(const scenario of ['recent','expired','previous-day','failed-latest']){
  const env=environment();await account(env,'A');addRun(env,'ok','A','check','success');
  env.db.prepare("UPDATE runs SET finished_at=?,created_at=?,day=? WHERE id='ok'").run(time()-(scenario==='expired'?1800:60),time()-120,scenario==='previous-day'?'2000-01-01':day());
  if(scenario==='failed-latest')addRun(env,'failed','A','check','failed');
  const result=await connectionCheck(env,'A');assert.equal(result.state,scenario==='recent'?'cached':'queued',scenario);
  assert.equal(env.sent.length,scenario==='recent'?0:1,scenario);
 }
});
test('concurrent login and manual diagnostics reuse outstanding tasks across minute boundaries',async()=>{
 for(const status of ['pending','queued','running']){
  const env=environment();await account(env,'A');addRun(env,'existing','A','check',status);env.db.prepare("UPDATE runs SET created_at=?,delivered_at=? WHERE id='existing'").run(time()-130,status==='queued'?time()-130:0);
  if(status==='pending')env.JOBS.send=async()=>{throw Error('queue unavailable');};
  const checks=await Promise.all([connectionCheck(env,'A'),connectionCheck(env,'A',{force:true})]);assert.ok(checks.every(r=>r.id==='existing'&&r.reused));
  assert.equal(env.db.prepare('SELECT COUNT(*) n FROM runs').get().n,1);
  const history=await (await api(env,'/api/runs',undefined,await account(env,'B'))).json();assert.equal(history.check,null);
 }
 const env=environment();await account(env,'A');const checks=await Promise.all(Array.from({length:6},()=>connectionCheck(env,'A',{force:true})));
 assert.equal(new Set(checks.map(c=>c.id)).size,1);assert.equal(env.sent.length,1);
});
test('login diagnostic reports durable queue failures and database failures without failing login',async(t)=>{
 const env=environment();zeppMock(t);env.db.prepare('UPDATE site_settings SET new_user_gift_days=7').run();
 const input={account:'failure@example.com',password:'dummy',consent:true,min_step:1,max_step:2};env.JOBS.send=async()=>{throw Error('private queue error');};
 let res=await api(env,'/api/login',input);assert.equal(res.status,200);let data=await res.json();assert.equal(data.check.state,'pending');assert.ok(data.check.id);
 res=await api(env,'/api/login',input);data=await res.json();assert.equal(data.check.state,'pending');assert.equal(data.check.reused,true);assert.equal(env.db.prepare('SELECT COUNT(*) n FROM runs').get().n,1);
 env.db.prepare("UPDATE runs SET status='failed'").run();env.db.exec("CREATE TRIGGER fail_diagnostic BEFORE INSERT ON runs BEGIN SELECT RAISE(ABORT,'private DB error'); END;");
 res=await api(env,'/api/login',input);assert.equal(res.status,200);data=await res.json();assert.equal(data.check.state,'unavailable');assert.ok(!JSON.stringify(data).includes('private'));assert.ok(res.headers.get('set-cookie'));
 env.db.prepare('UPDATE memberships SET expires_at=0').run();res=await api(env,'/api/login',input);assert.equal((await res.json()).check.state,'inactive');
});
test('registration gift is admin controlled, bounded, revision guarded and publicly described',async()=>{
 const env=environment(),admin=await administrator(env),user=await account(env,'existing');
 const initial=await (await api(env,'/api/zhuixins_x/site',undefined,admin)).json();assert.equal(initial.new_user_gift_days,0);
 const data={...initial,new_user_gift_days:7};
 assert.equal((await api(env,'/api/zhuixins_x/site',data,user)).status,401);
 assert.equal((await worker.fetch(req('/api/zhuixins_x/site',data,admin.cookie,'invalid'),env)).status,403);
 for(const value of [-1,0.5,3651,null,true,'7',[],{}])assert.equal((await api(env,'/api/zhuixins_x/site',{...data,new_user_gift_days:value},admin)).status,400);
 const existing=env.db.prepare('SELECT expires_at FROM memberships WHERE account_id=?').get(user.id).expires_at;
 assert.equal((await api(env,'/api/zhuixins_x/site',data,admin)).status,200);
 assert.equal((await (await api(env,'/api/site')).json()).new_user_gift_days,7);
 assert.equal((await api(env,'/api/zhuixins_x/site',{...data,new_user_gift_days:30},admin)).status,409);
 const {new_user_gift_days,...legacy}=data;
 assert.equal((await api(env,'/api/zhuixins_x/site',{...legacy,revision:2},admin)).status,200);
 assert.equal((await (await api(env,'/api/site')).json()).new_user_gift_days,7);
 assert.equal(env.db.prepare('SELECT expires_at FROM memberships WHERE account_id=?').get(user.id).expires_at,existing);
 const event=env.db.prepare("SELECT details FROM admin_audit WHERE action='site_update' LIMIT 1").get();assert.equal(JSON.parse(event.details).new_user_gift_days,7);
 assert.equal((await api(env,'/api/zhuixins_x/site',{...data,revision:3,new_user_gift_days:3650},admin)).status,200);
 assert.equal((await api(env,'/api/zhuixins_x/site',{...data,revision:4,new_user_gift_days:0},admin)).status,200);
});
test('verified registration earns one gift across concurrent login, renewal and profile restoration',async(t)=>{
 const env=environment();const mock=zeppMock(t);env.db.prepare('UPDATE site_settings SET new_user_gift_days=3').run();
 const input={account:'gift@example.com',password:'dummy',consent:true,min_step:1000,max_step:2000};
 const responses=await Promise.all([api(env,'/api/login',input),api(env,'/api/login',input)]);assert.ok(responses.every(r=>r.status===200));
 let member=env.db.prepare('SELECT * FROM memberships').get();assert.equal(member.registration_gift_days,3);assert.equal(member.expires_at,member.created_at+3*86400);
 assert.equal(env.db.prepare("SELECT COUNT(*) n FROM admin_audit WHERE action='registration_gift'").get().n,1);
 assert.ok(env.sent.length>0);assert.equal(mock.calls.filter(c=>c.url.includes('/band_data')&&c.opts.method==='POST').length,0);
 const res=await api(env,'/api/login',input),cookie=res.headers.get('set-cookie').split(';')[0];
 const status=await (await api(env,'/api/status',undefined,{cookie})).json();assert.equal(status.account.membership.active,true);
 const admin=await administrator(env),[code]=await activation(env,admin,7),a={cookie,csrf:status.csrf};
 assert.equal((await api(env,'/api/redeem',{code:code.code},a)).status,200);
 const renewed=env.db.prepare('SELECT expires_at FROM memberships').get().expires_at;assert.equal(renewed,member.expires_at+7*86400);
 env.db.prepare('DELETE FROM accounts').run();env.db.prepare('UPDATE site_settings SET registration_open=0,new_user_gift_days=30').run();
 assert.equal((await api(env,'/api/login',input)).status,200);member=env.db.prepare('SELECT * FROM memberships').get();
 assert.equal(member.expires_at,renewed);assert.equal(member.registration_gift_days,3);assert.equal(env.db.prepare("SELECT COUNT(*) n FROM admin_audit WHERE action='registration_gift'").get().n,1);
});
test('zero-day registration cannot claim later policy gifts and rejected admission receives nothing',async(t)=>{
 const env=environment();zeppMock(t);const input={account:'zero@example.com',password:'dummy',consent:true,min_step:1,max_step:2};
 env.db.prepare('UPDATE site_settings SET registration_open=0,new_user_gift_days=7').run();
 assert.equal((await api(env,'/api/login',input)).status,409);assert.equal(env.db.prepare('SELECT COUNT(*) n FROM memberships').get().n,0);
 env.db.prepare('UPDATE site_settings SET registration_open=1,new_user_gift_days=0').run();assert.equal((await api(env,'/api/login',input)).status,200);
 env.db.prepare('UPDATE site_settings SET new_user_gift_days=7').run();env.db.prepare('DELETE FROM accounts').run();assert.equal((await api(env,'/api/login',input)).status,200);
 const member=env.db.prepare('SELECT * FROM memberships').get();assert.equal(member.expires_at,0);assert.equal(member.registration_gift_days,0);
 assert.equal(env.db.prepare("SELECT COUNT(*) n FROM admin_audit WHERE action='registration_gift'").get().n,0);
});
test('registration gift audit failure rolls back the grant; retry credits once',async(t)=>{
 const env=environment();zeppMock(t);env.db.prepare('UPDATE site_settings SET new_user_gift_days=7').run();
 env.db.exec("CREATE TRIGGER fail_gift BEFORE INSERT ON admin_audit WHEN NEW.action='registration_gift' BEGIN SELECT RAISE(ABORT,'injected audit failure'); END;");
 const input={account:'retry@example.com',password:'dummy',consent:true,min_step:1,max_step:2};
 assert.equal((await api(env,'/api/login',input)).status,503);assert.equal(env.db.prepare('SELECT COUNT(*) n FROM memberships').get().n,0);
 env.db.exec('DROP TRIGGER fail_gift');assert.equal((await api(env,'/api/login',input)).status,200);
 const member=env.db.prepare('SELECT * FROM memberships').get();assert.equal(member.expires_at-member.created_at,7*86400);
 assert.equal(env.db.prepare("SELECT COUNT(*) n FROM admin_audit WHERE action='registration_gift'").get().n,1);
});
function environment(){
 const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');for(const file of ['0001_multiuser.sql','0002_delivery.sql','0003_verification.sql','0004_saas.sql','0005_operations.sql','0006_reliability.sql','0007_registration_gift.sql'])db.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
 const env={APP_ORIGIN:origin,MASTER_SECRET:'test-secret-only',MAX_ACCOUNTS:'200',db,sent:[],queries:0};
 function statement(sql,args=[]){return {bind(...v){return statement(sql,v);},async first(){env.queries++;return db.prepare(sql).get(...args)||null;},async all(){env.queries++;return {results:db.prepare(sql).all(...args)};},async run(){env.queries++;const r=db.prepare(sql).run(...args);return {meta:{changes:Number(r.changes)}};}};}
 env.DB={prepare:sql=>statement(sql),batch:async statements=>{db.exec('BEGIN');try{const r=await Promise.all(statements.map(s=>s.run()));db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}}};
 env.JOBS={send:async body=>env.sent.push(body),sendBatch:async items=>env.sent.push(...items.map(i=>i.body))};return env;
}
function req(path,data,cookie='',csrf='test-csrf',headers={}){return new Request(origin+path,{method:data===undefined?'GET':'POST',headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json','X-CSRF-Token':csrf,...headers},...(data===undefined?{}:{body:JSON.stringify(data)})});}
async function api(env,path,data,a={}){return worker.fetch(req(path,data,a.cookie,a.csrf),env);}
async function account(env,id,enabled=1){const tokens={user_id:id,login_token:'login-'+id,app_token:'app-'+id,bound_device_id:'ABCDEF123456'};env.db.prepare('INSERT INTO accounts(id,label,credentials,enabled,session_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(id,id+'***',await seal(tokens,env.MASTER_SECRET,'zepp:'+id),enabled,'version',time(),time());env.db.prepare('INSERT INTO memberships(account_id,expires_at,created_at,updated_at) VALUES(?,?,?,?)').run(id,time()+30*86400,time(),time());const s={id,version:'version',csrf:'test-csrf',exp:time()+600};return {id,csrf:s.csrf,cookie:'__Host-mimotion-user-v2='+await seal(s,env.MASTER_SECRET,'user-session-v2')};}
function addRun(env,id,owner,kind='manual',status='queued',d=day()){env.db.prepare('INSERT INTO runs(id,account_id,slot,kind,day,step,status,created_at,updated_at) VALUES(?,?,?,?,?,20000,?,?,?)').run(id,owner,id,kind,d,status,time(),time());}
function msg(id,attempts=1){return {body:{id},attempts,acked:false,retried:false,ack(){this.acked=true;},retry(){this.retried=true;}};}
function consume(env,m){return worker.queue({messages:[m]},env);}

test('legacy running jobs without an execution marker are never replayed',async()=>{
 const env=environment();await account(env,'A',0);addRun(env,'legacy','A','manual','running');env.db.prepare("UPDATE runs SET updated_at=? WHERE id='legacy'").run(time()-700);
 await worker.scheduled({scheduledTime:Date.parse(day()+'T01:15:00Z')},env);
 assert.equal(env.db.prepare("SELECT status FROM runs WHERE id='legacy'").get().status,'unknown');assert.ok(!env.sent.some(m=>m.id==='legacy'));
});

test('follow-up creation rolls back atomically and cron recovers without repeating POST',async(t)=>{
 const env=environment();await account(env,'A',0);addRun(env,'r','A');const mock=zeppMock(t,{below:true});
 env.db.exec("CREATE TRIGGER fail_followup BEFORE INSERT ON runs WHEN NEW.auto_round=2 BEGIN SELECT RAISE(ABORT,'injected batch failure'); END;");
 await consume(env,msg('r'));let source=env.db.prepare("SELECT * FROM runs WHERE id='r'").get();assert.equal(source.status,'success');assert.equal(source.auto_checks_scheduled,0);assert.equal(env.db.prepare("SELECT COUNT(*) n FROM runs WHERE parent_id='r'").get().n,0);
 env.db.exec('DROP TRIGGER fail_followup');await worker.scheduled({scheduledTime:Date.parse(day()+'T01:15:00Z')},env);source=env.db.prepare("SELECT * FROM runs WHERE id='r'").get();assert.equal(source.verification,'waiting');assert.equal(env.db.prepare("SELECT COUNT(*) n FROM runs WHERE parent_id='r'").get().n,2);assert.equal(mock.calls.filter(c=>c.opts.method==='POST').length,1);
});

test('safe GET retry is bounded; POST and malformed responses are never retried',async(t)=>{
 let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;return calls===1?new Response('private',{status:503}):Response.json({ok:true});});
 assert.equal((await fetchJSON('https://example.test')).data.ok,true);assert.equal(calls,2);
 calls=0;await assert.rejects(fetchJSON('https://example.test',{method:'POST'}),e=>e.retryable&&!e.message.includes('private'));assert.equal(calls,1);
 calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response('private',{headers:{'content-type':'application/octet-stream'}});});
 await assert.rejects(fetchJSON('https://example.test'),e=>e.code==='response_format'&&!e.message.includes('private'));assert.equal(calls,1);
 calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response('private',{status:429,headers:{'retry-after':'180'}});});
 await assert.rejects(fetchJSON('https://example.test'),e=>e.code==='rate_limited'&&e.retryAfter===180);assert.equal(calls,1);
});

test('pre-submit transient failure persists retry delay and never disables credentials',async(t)=>{
 const env=environment();await account(env,'A');addRun(env,'r','A');const mock=zeppMock(t),normal=globalThis.fetch;let failures=1;
 t.mock.method(globalThis,'fetch',async(url,opts)=>String(url).includes('/app_tokens')&&failures-->0?new Response(null,{status:429,headers:{'retry-after':'90'}}):normal(url,opts));
 await consume(env,msg('r'));let r=env.db.prepare("SELECT * FROM runs WHERE id='r'").get();assert.equal(r.status,'queued');assert.equal(r.phase,'preparing');assert.equal(r.attempt_count,1);assert.ok(r.next_attempt_at>=time()+89);assert.equal(r.error_code,'rate_limited');assert.equal(env.db.prepare('SELECT needs_login FROM accounts').get().needs_login,0);
 const early=msg('r');await consume(env,early);assert.equal(early.retried,true);assert.equal(mock.calls.filter(c=>c.opts.method==='POST').length,0);
 env.db.prepare("UPDATE runs SET next_attempt_at=0 WHERE id='r'").run();await consume(env,msg('r'));r=env.db.prepare("SELECT * FROM runs WHERE id='r'").get();assert.equal(r.status,'success');assert.equal(r.attempt_count,2);assert.equal(mock.calls.filter(c=>c.opts.method==='POST').length,1);
});

test('three transient attempts stop safely and protocol changes do not expire credentials',async(t)=>{
 const env=environment();await account(env,'A');addRun(env,'r','A');let calls=0;
 t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response(null,{status:503,headers:{'retry-after':'60'}});});
 for(let i=0;i<3;i++){env.db.prepare("UPDATE runs SET next_attempt_at=0 WHERE id='r'").run();await consume(env,msg('r'));}
 assert.equal(calls,3);assert.equal(env.db.prepare("SELECT status FROM runs WHERE id='r'").get().status,'failed');assert.equal(env.db.prepare('SELECT needs_login FROM accounts').get().needs_login,0);
 addRun(env,'format','A');t.mock.method(globalThis,'fetch',async()=>Response.json({unexpected:true}));await consume(env,msg('format'));assert.equal(env.db.prepare("SELECT error_code FROM runs WHERE id='format'").get().error_code,'response_format');assert.equal(env.db.prepare('SELECT enabled FROM accounts').get().enabled,1);
});

test('delayed checks update the source, converge and never repeat POST',async(t)=>{
 const env=environment();await account(env,'A');addRun(env,'r','A');const mock=zeppMock(t,{below:true});await consume(env,msg('r'));
 const children=env.db.prepare('SELECT * FROM runs WHERE parent_id=? ORDER BY auto_round').all('r');assert.equal(children.length,2);assert.ok(children[0].next_attempt_at>=time()+29);assert.ok(children[1].next_attempt_at>=time()+119);
 const early=msg(children[0].id);await consume(env,early);assert.equal(early.retried,true);
 env.db.prepare('UPDATE runs SET next_attempt_at=0 WHERE id=?').run(children[0].id);await consume(env,msg(children[0].id));assert.equal(env.db.prepare("SELECT verification FROM runs WHERE id='r'").get().verification,'waiting');
 const normal=globalThis.fetch;t.mock.method(globalThis,'fetch',async(url,opts={})=>String(url).includes('/band_data')&&opts.method!=='POST'?Response.json({message:'success',data:[{date:day(),summary:{stp:{ttl:25000}}}]}):normal(url,opts));
 env.db.prepare('UPDATE runs SET next_attempt_at=0 WHERE id=?').run(children[1].id);await consume(env,msg(children[1].id));const r=env.db.prepare("SELECT * FROM runs WHERE id='r'").get();assert.equal(r.verification,'matched');assert.equal(r.status,'success');assert.equal(r.observed_step,25000);
 await consume(env,msg(children[1].id));assert.equal(mock.calls.filter(c=>c.opts.method==='POST').length,1);
});

test('automatic verification has a final unresolved state and expires with membership',async(t)=>{
 const env=environment();await account(env,'A');addRun(env,'r','A');zeppMock(t,{below:true});await consume(env,msg('r'));
 const children=env.db.prepare('SELECT id FROM runs WHERE parent_id=? ORDER BY auto_round DESC').all('r');
 for(const child of children){env.db.prepare('UPDATE runs SET next_attempt_at=0 WHERE id=?').run(child.id);await consume(env,msg(child.id));}
 assert.equal(env.db.prepare("SELECT verification FROM runs WHERE id='r'").get().verification,'below_target');
 addRun(env,'other','A');await consume(env,msg('other'));env.db.prepare('UPDATE memberships SET expires_at=?').run(time()-1);
 for(const c of env.db.prepare('SELECT id FROM runs WHERE parent_id=?').all('other')){env.db.prepare('UPDATE runs SET next_attempt_at=0 WHERE id=?').run(c.id);await consume(env,msg(c.id));}
 assert.equal(env.db.prepare("SELECT verification FROM runs WHERE id='other'").get().verification,'below_target');
});

test('database outage after accepted POST recovers as unknown and cannot resubmit',async(t)=>{
 const env=environment();await account(env,'A',0);addRun(env,'r','A');const mock=zeppMock(t);
 env.db.exec("CREATE TRIGGER fail_finish BEFORE UPDATE OF status ON runs WHEN NEW.id='r' AND NEW.status IN ('success','unknown') BEGIN SELECT RAISE(ABORT,'injected failure'); END;");
 await assert.rejects(consume(env,msg('r')));const interrupted=env.db.prepare("SELECT * FROM runs WHERE id='r'").get();assert.equal(interrupted.phase,'accepted');assert.equal(interrupted.status,'running');
 env.db.exec('DROP TRIGGER fail_finish');env.db.prepare("UPDATE runs SET updated_at=? WHERE id='r'").run(time()-700);
 await worker.scheduled({scheduledTime:Date.parse(day()+'T01:15:00Z')},env);assert.equal(env.db.prepare("SELECT status FROM runs WHERE id='r'").get().status,'unknown');assert.equal(env.db.prepare("SELECT COUNT(*) n FROM runs WHERE parent_id='r'").get().n,2);
 await consume(env,msg('r'));assert.equal(mock.calls.filter(c=>c.opts.method==='POST').length,1);
});

test('scheduler catches up one missed slot within 30 minutes and deduplicates',async()=>{
 const env=environment();await account(env,'A');const at=Date.parse(day()+'T00:50:00Z');await worker.scheduled({scheduledTime:at},env);await worker.scheduled({scheduledTime:at+300000},env);
 assert.equal(env.db.prepare('SELECT COUNT(*) n FROM runs').get().n,1);assert.equal(env.sent.length,1);assert.equal(env.db.prepare('SELECT slot FROM runs').get().slot,'schedule:'+day()+'T08');
 const late=environment();await account(late,'A');await worker.scheduled({scheduledTime:Date.parse(day()+'T01:10:00Z')},late);assert.equal(late.sent.length,0);
});

test('outbox recovery respects delivery bounds, future delays and live execution leases',async()=>{
 const env=environment();for(const id of ['lost','exhausted','future','live','pre','post']){await account(env,id,0);addRun(env,id,id);}
 env.db.prepare('UPDATE runs SET updated_at=?,delivered_at=?,delivery_count=1').run(time()-1200,time()-1200);
 env.db.prepare("UPDATE runs SET delivery_count=4 WHERE id='exhausted'").run();env.db.prepare("UPDATE runs SET next_attempt_at=? WHERE id='future'").run(time()+600);
 env.db.prepare("UPDATE runs SET status='running',execution_id='test-execution',attempt_count=1 WHERE id IN ('live','pre','post')").run();env.db.prepare("UPDATE runs SET phase='submitting' WHERE id='post'").run();env.db.prepare("UPDATE accounts SET lease_until=? WHERE id='live'").run(time()+300);
 await worker.scheduled({scheduledTime:Date.parse(day()+'T01:15:00Z')},env);
 const state=id=>env.db.prepare('SELECT * FROM runs WHERE id=?').get(id);
 assert.equal(state('lost').delivery_count,2);assert.equal(state('exhausted').status,'failed');assert.equal(state('future').delivery_count,1);assert.equal(state('live').status,'running');assert.equal(state('pre').status,'queued');assert.equal(state('post').status,'unknown');assert.ok(!env.sent.some(m=>m.id==='post'));
});
function zeppMock(t,options={}){const calls=[];const cloud=new Map();let active=0,maxActive=0;
 t.mock.method(globalThis,'fetch',async(url,opts={})=>{url=String(url);calls.push({url,opts});
 if(url.includes('/registrations/tokens'))return new Response(null,{status:303,headers:{Location:'https://example.test/?access=valid-access'}});
 if(url.includes('/v2/client/login')){assert.equal(new Headers(opts.headers).has('x-hm-ekv'),false);return Response.json({result:'ok',token_info:{login_token:'login-token',app_token:'app-token',user_id:options.userId||'verified-user'}});}
 if(url.includes('/device/binds.json'))return Response.json({items:[]});
 if(url.includes('/client/app_tokens')){if(options.expired)return Response.json({result:'fail'},{status:401});return Response.json({result:'ok',token_info:{app_token:'refreshed-'+new URL(url).searchParams.get('login_token')}});}
 if(url.includes('getUserInfo.json'))return Response.json({message:'success'});
 if(url.includes('/band_data.json')&&opts.method!=='POST'){
   if(options.unreadable)return Response.json({message:'success',data:[]});
   const q=new URL(url).searchParams, uid=q.get('userid');
   return Response.json({message:'success',data:[{date_time:q.get('from_date'),summary:btoa(JSON.stringify({stp:{ttl:options.below?1000:cloud.get(uid)||1000}}))}]});
 }
 if(url.includes('/band_data.json')){active++;maxActive=Math.max(active,maxActive);await new Promise(r=>setTimeout(r,15));active--;if(options.timeout)throw new Error('private-token-upstream');cloud.set(opts.body.get('userid'),JSON.parse(JSON.parse(opts.body.get('data_json'))[0].summary).stp.ttl);return Response.json({message:'success'});}
 throw new Error('Unexpected fetch');});return {calls,get maxActive(){return maxActive;}};}

test('public page, legacy sessions, origin and CSRF protection',async()=>{const env=environment();assert.match(await (await api(env,'/')).text(),/兑换激活码/);assert.equal((await api(env,'/api/run',{})).status,401);const a=await account(env,'A');assert.equal((await worker.fetch(req('/api/settings',{},a.cookie,'bad'),env)).status,403);assert.equal((await worker.fetch(req('/api/login',{},'', '',{Origin:'https://evil.test'}),env)).status,403);assert.equal((await api(env,'/api/config/save',{},a)).status,404);assert.equal((await api(env,'/api/run',{}, {cookie:'__Host-mimotion-session=old'})).status,401);});

test('Zepp direct login creates isolated encrypted account without password; re-login revokes old cookie',async(t)=>{const env=environment();zeppMock(t);const input={account:'test@example.com',password:'secret#password',min_step:18000,max_step:25000,consent:true};const r=await api(env,'/api/login',input);assert.equal(r.status,200);const c=r.headers.get('set-cookie').split(';')[0];assert.match(r.headers.get('set-cookie'),/HttpOnly; Secure; SameSite=Strict/);const status=await (await api(env,'/api/status',undefined,{cookie:c})).json();assert.equal(status.signed_in,true);assert.equal(status.account.enabled,false);const row=env.db.prepare('SELECT * FROM accounts').get();const stored=JSON.stringify(row);assert.ok(!stored.includes(input.password));assert.ok(!stored.includes('login-token'));assert.ok(!stored.includes(input.account));assert.equal((await open(row.credentials,env.MASTER_SECRET,'zepp:'+row.id)).user_id,'verified-user');await assert.rejects(open(row.credentials,env.MASTER_SECRET,'zepp:someone-else'));await api(env,'/api/login',input);assert.equal((await (await api(env,'/api/status',undefined,{cookie:c})).json()).signed_in,false);assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n,1);});

test('two users can run concurrently with their own tokens and cannot read/change/delete each other',async(t)=>{const env=environment(), a=await account(env,'A'),b=await account(env,'B');const mock=zeppMock(t);addRun(env,'run-a','A');addRun(env,'run-b','B');await Promise.all([consume(env,msg('run-a')),consume(env,msg('run-b'))]);assert.equal(mock.maxActive,2);const submits=mock.calls.filter(c=>c.url.includes('/band_data.json')&&c.opts.method==='POST');assert.equal(submits.length,2);for(const call of submits){const p=call.opts.body;const uid=p.get('userid');assert.equal(call.opts.headers.apptoken,'refreshed-login-'+uid);assert.equal(p.get('last_deviceid'),'ABCDEF123456');const payload=JSON.parse(p.get('data_json'))[0];assert.equal(payload.date,day());assert.equal(JSON.parse(payload.summary).stp.ttl,20000);}
 const ar=await (await api(env,'/api/runs?account_id=B',undefined,a)).json();assert.deepEqual(ar.runs.map(r=>r.id),['run-a']);assert.equal((await api(env,'/api/settings',{account_id:'B',min_step:1,max_step:2,enabled:false},a)).status,200);assert.equal(env.db.prepare("SELECT enabled FROM accounts WHERE id='B'").get().enabled,1);assert.equal((await api(env,'/api/delete',{confirm:'DELETE',account_id:'B'},a)).status,200);assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM runs').get().n,1);assert.equal((await api(env,'/api/runs',undefined,a)).status,401);assert.equal((await api(env,'/api/runs',undefined,b)).status,200);});

test('same account and duplicate deliveries never submit concurrently or repeat success',async(t)=>{const env=environment();await account(env,'A');addRun(env,'one','A');addRun(env,'two','A');const mock=zeppMock(t), m=msg('two');await Promise.all([consume(env,msg('one')),consume(env,msg('one')),consume(env,m)]);assert.equal(mock.maxActive,1);assert.equal(mock.calls.filter(c=>c.url.includes('/band_data')&&c.opts.method==='POST').length,1);assert.equal(m.retried,true);await consume(env,msg('one'));assert.equal(mock.calls.filter(c=>c.url.includes('/band_data')&&c.opts.method==='POST').length,1);await consume(env,msg('two',2));assert.equal(mock.calls.filter(c=>c.url.includes('/band_data')&&c.opts.method==='POST').length,2);});

test('uncertain POST is visible and never automatically resubmitted',async(t)=>{const env=environment();await account(env,'A');addRun(env,'r','A');const mock=zeppMock(t,{timeout:true});await consume(env,msg('r'));await consume(env,msg('r',2));const row=env.db.prepare('SELECT * FROM runs').get();assert.equal(row.status,'unknown');assert.ok(!row.message.includes('private-token'));assert.equal(mock.calls.filter(c=>c.url.includes('/band_data')&&c.opts.method==='POST').length,1);assert.equal(env.db.prepare('SELECT lease_until FROM accounts').get().lease_until,0);});

test('expired credentials pause the user; paused and previous-day jobs do not submit',async(t)=>{const env=environment();await account(env,'A');addRun(env,'r','A');const mock=zeppMock(t,{expired:true});await consume(env,msg('r'));assert.equal(env.db.prepare('SELECT enabled FROM accounts').get().enabled,0);assert.equal(env.db.prepare('SELECT needs_login FROM accounts').get().needs_login,1);addRun(env,'s','A','schedule');addRun(env,'old','A','manual','queued','2001-01-01');await consume(env,msg('s'));await consume(env,msg('old'));assert.equal(mock.calls.filter(c=>c.url.includes('/band_data')&&c.opts.method==='POST').length,0);assert.deepEqual(env.db.prepare('SELECT status FROM runs ORDER BY id').all().map(r=>r.status),['skipped','failed','skipped']);});

test('scheduler batches 200 accounts within query budget, retries outbox, and deduplicates slots',async()=>{const env=environment();for(let i=0;i<200;i++)await account(env,'u'+i);env.queries=0;const tick={scheduledTime:Date.parse(day()+'T00:35:00Z')};await worker.scheduled(tick,env);assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM runs').get().n,200);assert.equal(env.sent.length,200);assert.ok(env.queries<30);env.sent=[];await worker.scheduled(tick,env);assert.equal(env.sent.length,0);assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM runs').get().n,200);
 env.db.prepare("UPDATE runs SET status='pending'").run();env.JOBS.sendBatch=async()=>{throw new Error('queue unavailable');};await worker.scheduled({scheduledTime:tick.scheduledTime+300000},env);assert.equal(env.db.prepare("SELECT COUNT(*) AS n FROM runs WHERE status='pending'").get().n,200);env.JOBS.sendBatch=async items=>env.sent.push(...items);await worker.scheduled({scheduledTime:tick.scheduledTime+600000},env);assert.equal(env.sent.length,200);});

test('login and manual run rate limits do not create extra jobs',async(t)=>{const env=environment();const a=await account(env,'A');assert.equal((await api(env,'/api/run',{},a)).status,202);assert.equal((await api(env,'/api/run',{},a)).status,429);assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM runs').get().n,1);zeppMock(t);const data={account:'a@example.com',password:'p',min_step:1,max_step:2,consent:true};for(let i=0;i<5;i++)assert.equal((await api(env,'/api/login',data)).status,200);assert.equal((await api(env,'/api/login',data)).status,429);});

test('non-JSON failures never expose upstream bodies; invalid inputs rejected',async(t)=>{t.mock.method(globalThis,'fetch',async()=>new Response('secret-upstream-token',{status:502,headers:{'content-type':'application/octet-stream'}}));await assert.rejects(fetchJSON('https://example.test'),e=>e.code==='upstream_unavailable'&&!e.message.includes('secret-upstream'));assert.equal(validate({account:'13800138000',password:'a#b',min_step:1,max_step:2}).account,'+8613800138000');assert.throws(()=>validate({account:'a@example.com',password:'p',min_step:4,max_step:2}));});


test('automatic post-login diagnostic only reads; outcome includes today steps and audit timestamps',async(t)=>{const env=environment();const mock=zeppMock(t);const input={account:'check@example.com',password:'p',min_step:18000,max_step:25000,consent:true};const res=await api(env,'/api/login',input);assert.equal(res.status,200);env.db.prepare('UPDATE memberships SET expires_at=?').run(time()+86400);await api(env,'/api/login',input);const r=env.db.prepare('SELECT * FROM runs').get();assert.equal(r.kind,'check');await consume(env,msg(r.id));const checked=env.db.prepare('SELECT * FROM runs').get();assert.equal(checked.status,'success');assert.equal(checked.observed_step,1000);assert.equal(checked.verification,'readable');assert.ok(checked.started_at&&checked.finished_at&&checked.checked_at);assert.equal(mock.calls.filter(c=>c.url.includes('/band_data')&&c.opts.method==='POST').length,0);});

test('accepted submission persists before/after evidence and confirmed comparison',async(t)=>{const env=environment();await account(env,'A');addRun(env,'r','A');zeppMock(t);await consume(env,msg('r'));const row=env.db.prepare('SELECT * FROM runs').get();assert.equal(row.status,'success');assert.equal(row.before_step,1000);assert.equal(row.observed_step,20000);assert.equal(row.verification,'matched');});

test('accepted submission with stale readback is not marked verified',async(t)=>{const env=environment();await account(env,'A');addRun(env,'r','A');zeppMock(t,{below:true});await consume(env,msg('r'));const row=env.db.prepare('SELECT * FROM runs').get();assert.equal(row.status,'success');assert.equal(row.verification,'waiting');assert.equal(row.observed_step,1000);});

test('missing upstream rows stay null, never zero or verified success',async(t)=>{const env=environment();await account(env,'A');addRun(env,'r','A');zeppMock(t,{unreadable:true});await consume(env,msg('r'));const row=env.db.prepare('SELECT * FROM runs').get();assert.equal(row.status,'success');assert.equal(row.verification,'waiting');assert.equal(row.observed_step,null);assert.equal(row.before_step,null);});

test('recheck is scoped to the owner, supports past dates, updates evidence without another POST',async(t)=>{const env=environment(),a=await account(env,'A'),b=await account(env,'B');addRun(env,'original','A','manual','success','2026-09-01');const mock=zeppMock(t);assert.equal((await api(env,'/api/verify',{id:'original'},b)).status,404);const result=await api(env,'/api/verify',{id:'original'},a);assert.equal(result.status,202);const {id}=await result.json();await consume(env,msg(id));assert.equal(mock.calls.filter(c=>c.url.includes('/band_data')&&c.opts.method==='POST').length,0);assert.equal(new URL(mock.calls.find(c=>c.url.includes('/band_data')).url).searchParams.get('from_date'),'2026-09-01');const original=env.db.prepare("SELECT * FROM runs WHERE id='original'").get();assert.equal(original.status,'success');assert.equal(original.observed_step,1000);assert.equal(original.verification,'below_target');assert.ok(original.checked_at);const hist=await (await api(env,'/api/runs?filter=check',undefined,a)).json();assert.equal(hist.runs.length,1);assert.equal(hist.runs[0].parent_id,'original');});

test('history filters, pagination, statistics and current-user scope are consistent',async()=>{const env=environment(),a=await account(env,'A');await account(env,'B');for(let i=0;i<35;i++)addRun(env,'a'+String(i).padStart(2,'0'),'A','manual',i<5?'failed':'success');addRun(env,'b','B');const first=await (await api(env,'/api/runs',undefined,a)).json();const second=await (await api(env,'/api/runs?page=1',undefined,a)).json();assert.equal(first.runs.length,30);assert.equal(first.has_more,true);assert.equal(second.runs.length,5);assert.equal(new Set([...first.runs,...second.runs].map(r=>r.id)).size,35);assert.equal(first.stats.total,35);assert.equal(first.stats.accepted,30);const attention=await (await api(env,'/api/runs?filter=attention',undefined,a)).json();assert.equal(attention.runs.length,5);assert.equal((await api(env,'/api/runs?filter=invalid',undefined,a)).status,400);assert.equal((await api(env,'/api/runs?page=-1',undefined,a)).status,400);});

test('date-specific parser accepts base64/JSON summaries but rejects ambiguity, wrong dates and malformed totals',async()=>{const {parseDaySteps}=await import('../src/verification.js');const d='2026-09-15', row=summary=>({date_time:d,summary});assert.equal(parseDaySteps({data:[row(btoa(JSON.stringify({stp:{ttl:3210}})))]},d),3210);assert.equal(parseDaySteps({data:[row(JSON.stringify({stp:{ttl:0}}))]},d),0);for(const data of [{data:[]},{data:[row('invalid')]},{data:[{date_time:'2026-09-14',summary:{stp:{ttl:100}}}]},{data:[row({stp:{ttl:100}}),row({stp:{ttl:200}})]},{data:[row({stp:{ttl:-1}})]},{data:[row({stp:{ttl:'100'}})]}])assert.equal(parseDaySteps(data,d),null);});


async function administrator(env){
 const {hash}=await import('../src/licensing.js');const key='test-owner-key-with-at-least-256-bits-in-production';
 env.db.prepare('INSERT INTO admin_auth(id,key_hash,version,updated_at) VALUES(1,?,?,?)').run(await hash('admin-key:'+key),'admin-version',time());
 const res=await api(env,'/api/zhuixins_x/login',{key});assert.equal(res.status,200);const cookie=res.headers.get('set-cookie').split(';')[0];const s=await (await api(env,'/api/zhuixins_x/status',undefined,{cookie})).json();return {cookie,csrf:s.csrf,key};
}
async function activation(env,admin,days=7,count=1){const r=await api(env,'/api/zhuixins_x/codes/create',{days,count,note:'test-only'},admin);assert.equal(r.status,200,await r.clone().text());return (await r.json()).codes;}

test('new users can log in and see history but cannot execute before activation',async(t)=>{const env=environment();zeppMock(t);const res=await api(env,'/api/login',{account:'new@example.com',password:'p',min_step:1,max_step:2,consent:true});assert.equal(res.status,200);const cookie=res.headers.get('set-cookie').split(';')[0];const s=await (await api(env,'/api/status',undefined,{cookie})).json();const a={cookie,csrf:s.csrf};assert.equal(s.account.membership.active,false);assert.equal(env.sent.length,0);for(const path of ['/api/run','/api/check'])assert.equal((await api(env,path,{},a)).status,403);assert.equal((await api(env,'/api/settings',{min_step:1,max_step:2,enabled:true},a)).status,403);assert.equal((await api(env,'/api/runs',undefined,a)).status,200);assert.equal((await api(env,'/api/license',undefined,a)).status,200);const admin=await administrator(env),[code]=await activation(env,admin,7);const redeemed=await api(env,'/api/redeem',{code:code.code},a);assert.equal(redeemed.status,200);const r=await redeemed.json();assert.equal(r.membership.active,true);assert.ok(Math.abs(r.membership.expires_at-(time()+7*86400))<=1);assert.equal((await api(env,'/api/check',{},a)).status,202);});

test('renewal appends to active expiry, starts now after expiry, and is idempotent',async()=>{const env=environment(),a=await account(env,'A'),admin=await administrator(env);const [first,second]=await activation(env,admin,7,2);const initial=env.db.prepare('SELECT expires_at FROM memberships').get().expires_at;let r=await (await api(env,'/api/redeem',{code:first.code.toLowerCase().replaceAll('-',' ')},a)).json();assert.equal(r.membership.expires_at,initial+7*86400);r=await (await api(env,'/api/redeem',{code:first.code},a)).json();assert.equal(r.already_redeemed,true);assert.equal(r.membership.expires_at,initial+7*86400);env.db.prepare('UPDATE memberships SET expires_at=?').run(time()-86400);r=await (await api(env,'/api/redeem',{code:second.code},a)).json();assert.ok(Math.abs(r.membership.expires_at-(time()+7*86400))<=1);assert.equal(env.db.prepare('SELECT COUNT(*) n FROM license_redemptions').get().n,2);});

test('parallel claims credit one user once, distinct codes stack without lost updates',async()=>{const env=environment(),a=await account(env,'A'),b=await account(env,'B'),admin=await administrator(env);const [one,two,three]=await activation(env,admin,1,3);const results=await Promise.all([api(env,'/api/redeem',{code:one.code},a),api(env,'/api/redeem',{code:one.code},b)]);assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);assert.equal(env.db.prepare('SELECT COUNT(*) n FROM license_redemptions').get().n,1);const before=env.db.prepare("SELECT expires_at FROM memberships WHERE account_id='A'").get().expires_at;await Promise.all([api(env,'/api/redeem',{code:two.code},a),api(env,'/api/redeem',{code:three.code},a)]);assert.equal(env.db.prepare("SELECT expires_at FROM memberships WHERE account_id='A'").get().expires_at,before+2*86400);});

test('redemption trigger failure rolls back both code claim and credited time',async()=>{const env=environment(),a=await account(env,'A'),admin=await administrator(env),[code]=await activation(env,admin);const before=env.db.prepare('SELECT expires_at FROM memberships').get().expires_at;env.db.exec("CREATE TRIGGER reject_test BEFORE INSERT ON license_redemptions BEGIN SELECT RAISE(ABORT,'test rollback'); END");assert.equal((await api(env,'/api/redeem',{code:code.code},a)).status,503);assert.equal(env.db.prepare('SELECT redeemed_by FROM activation_codes').get().redeemed_by,null);assert.equal(env.db.prepare('SELECT expires_at FROM memberships').get().expires_at,before);env.db.exec('DROP TRIGGER reject_test');assert.equal((await api(env,'/api/redeem',{code:code.code},a)).status,200);});

test('revoked, stale, and suspended-user activation attempts never consume a code',async()=>{const env=environment(),a=await account(env,'A'),admin=await administrator(env);const [revoked,stale,valid]=await activation(env,admin,7,3);await api(env,'/api/zhuixins_x/codes/revoke',{id:revoked.id},admin);env.db.prepare('UPDATE activation_codes SET valid_until=? WHERE id=?').run(time(),stale.id);for(const code of [revoked,stale])assert.equal((await api(env,'/api/redeem',{code:code.code},a)).status,409);env.db.prepare('UPDATE memberships SET suspended=1').run();assert.equal((await api(env,'/api/redeem',{code:valid.code},a)).status,403);assert.equal(env.db.prepare('SELECT COUNT(*) n FROM license_redemptions').get().n,0);});

test('ordinary user sessions cannot access admin endpoints, forged roles and CSRF fail',async()=>{const env=environment(),a=await account(env,'A');for(const path of ['overview','users','codes','audit'])assert.equal((await api(env,'/api/zhuixins_x/'+path,undefined,a)).status,401);assert.equal((await api(env,'/api/zhuixins_x/codes/create',{days:7,count:1},a)).status,401);const admin=await administrator(env);assert.equal((await worker.fetch(req('/api/zhuixins_x/codes/create',{days:7,count:1},admin.cookie,'wrong'),env)).status,403);assert.equal((await worker.fetch(req('/api/zhuixins_x/login',{key:admin.key},'','',{Origin:'https://evil.test'}),env)).status,403);const users=await (await api(env,'/api/zhuixins_x/users',undefined,admin)).json();assert.equal(users.users[0].account_id,'A');assert.ok(!JSON.stringify(users).includes('credentials'));assert.ok(!JSON.stringify(users).includes('login-A'));const [c]=await activation(env,admin);const list=await (await api(env,'/api/zhuixins_x/codes',undefined,admin)).json();assert.ok(!JSON.stringify(list).includes(c.code));assert.equal((await (await api(env,'/api/zhuixins_x/codes/reveal',{id:c.id},admin)).json()).code,c.code);});

test('expiry and suspension block queued jobs and scheduler; last-moment expiry prevents POST',async(t)=>{const env=environment(),a=await account(env,'A');await account(env,'B');await api(env,'/api/run',{},a);env.db.prepare("UPDATE memberships SET expires_at=? WHERE account_id='A'").run(time()-1);env.db.prepare("UPDATE memberships SET suspended=1 WHERE account_id='B'").run();const mock=zeppMock(t);await consume(env,msg(env.sent[0].id));assert.equal(mock.calls.length,0);assert.equal(env.db.prepare('SELECT status FROM runs').get().status,'skipped');await worker.scheduled({scheduledTime:Date.parse(day()+'T00:35:00Z')},env);assert.equal(env.db.prepare('SELECT COUNT(*) n FROM runs').get().n,1);
 env.db.prepare("UPDATE memberships SET expires_at=? WHERE account_id='A'").run(time()+86400);addRun(env,'late','A');const old=globalThis.fetch;t.mock.method(globalThis,'fetch',async(url,opts)=>{const r=await old(url,opts);if(String(url).includes('band_data')&&opts.method!=='POST')env.db.prepare("UPDATE memberships SET expires_at=? WHERE account_id='A'").run(time()-1);return r;});await consume(env,msg('late'));assert.equal(mock.calls.filter(c=>c.opts.method==='POST').length,0);assert.equal(env.db.prepare("SELECT status FROM runs WHERE id='late'").get().status,'skipped');});

test('admin changes use revisions, are audited, and can suspend/resume without extending time',async()=>{const env=environment();await account(env,'A');const admin=await administrator(env);const get=()=>env.db.prepare('SELECT * FROM memberships').get();let m=get();assert.equal((await api(env,'/api/zhuixins_x/users/update',{id:'A',revision:m.revision,mode:'extend',days:3,reason:'support'},admin)).status,200);assert.equal(get().expires_at,m.expires_at+3*86400);assert.equal((await api(env,'/api/zhuixins_x/users/update',{id:'A',revision:m.revision,mode:'expiry',expires_at:0},admin)).status,409);m=get();await api(env,'/api/zhuixins_x/users/update',{id:'A',revision:m.revision,mode:'suspend'},admin);assert.equal(get().suspended,1);await api(env,'/api/zhuixins_x/users/update',{id:'A',revision:get().revision,mode:'resume'},admin);assert.equal(get().suspended,0);assert.equal(get().expires_at,m.expires_at);const audit=await (await api(env,'/api/zhuixins_x/audit',undefined,admin)).json();assert.ok(audit.events.some(e=>e.action==='user_extend'));});

test('removing a profile preserves expiry and bans; admin key rotation revokes all old sessions',async()=>{const env=environment(),a=await account(env,'A'),admin=await administrator(env);env.db.prepare('UPDATE memberships SET suspended=1').run();assert.equal((await api(env,'/api/delete',{confirm:'DELETE'},a)).status,200);assert.equal(env.db.prepare('SELECT COUNT(*) n FROM accounts').get().n,0);assert.equal(env.db.prepare('SELECT suspended FROM memberships').get().suspended,1);const r=await api(env,'/api/zhuixins_x/rotate-key',{confirm:true},admin);assert.equal(r.status,200);const {key}=await r.json();assert.equal(key.length,43);assert.equal((await api(env,'/api/zhuixins_x/users',undefined,admin)).status,401);assert.equal((await api(env,'/api/zhuixins_x/login',{key:admin.key})).status,401);assert.equal((await api(env,'/api/zhuixins_x/login',{key})).status,200);});

test('migration grants existing accounts exactly seven days and does not create a new-user trial',()=>{const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');for(const file of ['0001_multiuser.sql','0002_delivery.sql','0003_verification.sql'])db.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));db.prepare('INSERT INTO accounts(id,label,credentials,session_version,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('existing','masked','encrypted','v',time(),time());db.exec(readFileSync(new URL('../migrations/0004_saas.sql',import.meta.url),'utf8'));const m=db.prepare('SELECT * FROM memberships').get();assert.equal(m.account_id,'existing');assert.ok(Math.abs(m.expires_at-(time()+7*86400))<=1);assert.equal(db.prepare('SELECT COUNT(*) n FROM activation_codes').get().n,0);});

test('site settings require administrator, validate input and prevent stale overwrites',async()=>{
 const env=environment(),a=await account(env,'A'),admin=await administrator(env);
 const initial=await (await api(env,'/api/site')).json();assert.equal(initial.registration_open,true);assert.deepEqual(Object.keys(initial).sort(),['announcement','contact','name','new_user_gift_days','registration_open']);
 const data={name:'My site',announcement:'<img src=x onerror=alert(1)>',contact:'support@example.test',registration_open:false,revision:1};
 assert.equal((await api(env,'/api/zhuixins_x/site',data,a)).status,401);
 assert.equal((await api(env,'/api/zhuixins_x/site',data,{...admin,csrf:'wrong'})).status,403);
 assert.equal((await api(env,'/api/zhuixins_x/site',{...data,registration_open:'false'},admin)).status,400);
 assert.equal((await api(env,'/api/zhuixins_x/site',data,admin)).status,200);
 assert.equal((await api(env,'/api/zhuixins_x/site',{...data,name:'stale'},admin)).status,409);
 const published=await (await api(env,'/api/site')).json();assert.equal(published.name,'My site');assert.equal(published.registration_open,false);assert.equal(published.announcement,data.announcement);
 assert.equal(env.db.prepare("SELECT COUNT(*) n FROM admin_audit WHERE action='site_update'").get().n,1);
});

test('closed registration rejects new identities while existing members can restore deleted profiles',async(t)=>{
 const env=environment();zeppMock(t);const input={account:'known@example.com',password:'dummy',min_step:1000,max_step:2000,consent:true};
 env.db.prepare('UPDATE site_settings SET registration_open=0').run();assert.equal((await api(env,'/api/login',input)).status,409);assert.equal(env.db.prepare('SELECT COUNT(*) n FROM accounts').get().n,0);
 env.db.prepare('UPDATE site_settings SET registration_open=1').run();assert.equal((await api(env,'/api/login',input)).status,200);
 env.db.prepare('DELETE FROM accounts').run();env.db.prepare('UPDATE site_settings SET registration_open=0').run();assert.equal((await api(env,'/api/login',input)).status,200);
 assert.equal(env.db.prepare('SELECT COUNT(*) n FROM memberships').get().n,1);
});

test('next schedule respects Beijing rollover, paused plans, credentials and subscription cutoff',async()=>{
 const {nextExecution}=await import('../src/schedule.js');const now=Date.parse('2026-09-15T14:36:00Z'),a={enabled:1,needs_login:0},m={active:true,suspended:false,expires_at:now/1000+86400};
 assert.equal(nextExecution(a,m,now).at,Date.parse('2026-09-16T00:35:00Z')/1000);
 for(const [account,access] of [[{...a,enabled:0},m],[{...a,needs_login:1},m],[a,{...m,active:false}],[a,{...m,suspended:true}],[null,m],[a,{...m,expires_at:now/1000+60}]])assert.equal(nextExecution(account,access,now).at,null);
});

test('runtime overview is scoped to current account and labels the date of the latest reading',async()=>{
 const env=environment(),a=await account(env,'A');await account(env,'B');addRun(env,'a-run','A','manual','success','2026-09-01');addRun(env,'b-run','B','manual','success');
 env.db.prepare("UPDATE runs SET observed_step=123,checked_at=? WHERE id='a-run'").run(time());env.db.prepare("UPDATE runs SET observed_step=999,checked_at=? WHERE id='b-run'").run(time()+20);
 const h=await (await api(env,'/api/runs?account_id=B',undefined,a)).json();assert.equal(h.runtime.latest.id,'a-run');assert.equal(h.runtime.reading.observed_step,123);assert.equal(h.runtime.reading.day,'2026-09-01');
});

test('user detail and notes stay administrator-only, omit credentials and guard stale edits',async()=>{
 const env=environment(),a=await account(env,'A'),admin=await administrator(env);addRun(env,'only-A','A');await account(env,'B');addRun(env,'only-B','B');
 const path='/api/zhuixins_x/users/detail?id=A';assert.equal((await api(env,path,undefined,a)).status,401);
 assert.equal((await api(env,'/api/zhuixins_x/users/note',{id:'A',note:'private admin note',revision:0},admin)).status,200);
 assert.equal((await api(env,'/api/zhuixins_x/users/note',{id:'A',note:'stale',revision:0},admin)).status,409);
 const d=await (await api(env,path,undefined,admin)).json();assert.equal(d.note.note,'private admin note');assert.deepEqual(d.runs.map(r=>r.id),['only-A']);for(const field of ['credentials','session_version','key_hash','login_token'])assert.ok(!JSON.stringify(d).includes(field));
 const publicHistory=await (await api(env,'/api/runs',undefined,a)).text();assert.ok(!publicHistory.includes('private admin note'));
 env.db.prepare("DELETE FROM accounts WHERE id='A'").run();const deleted=await (await api(env,path,undefined,admin)).json();assert.equal(deleted.account,null);assert.equal(deleted.note.note,'private admin note');
});

test('issue review is atomic, administrator-only, audited, and does not repeat a task',async()=>{
 const env=environment(),a=await account(env,'A'),admin=await administrator(env);addRun(env,'issue','A','manual','unknown');
 assert.equal((await api(env,'/api/zhuixins_x/issues',undefined,a)).status,401);
 let d=await (await api(env,'/api/zhuixins_x/issues',undefined,admin)).json();assert.equal(d.issues[0].category,'unknown');const r=d.issues[0];
 const review={id:r.id,stamp:r.stamp,revision:0,note:'Asked user to check cloud data'};
 assert.equal((await api(env,'/api/zhuixins_x/issues/review',review,admin)).status,200);
 assert.equal((await api(env,'/api/zhuixins_x/issues/review',review,admin)).status,409);
 d=await (await api(env,'/api/zhuixins_x/issues',undefined,admin)).json();assert.equal(d.issues.length,0);assert.equal(d.counts.handled,1);assert.equal(env.sent.length,0);assert.equal(env.db.prepare("SELECT status FROM runs WHERE id='issue'").get().status,'unknown');
 env.db.prepare("UPDATE runs SET verification='below_target',checked_at=? WHERE id='issue'").run(time());d=await (await api(env,'/api/zhuixins_x/issues',undefined,admin)).json();assert.equal(d.issues.length,1);assert.equal(d.issues[0].review_revision,1);
 assert.equal((await api(env,'/api/zhuixins_x/issues/review',{...review,revision:1},admin)).status,409);
 assert.equal(env.db.prepare("SELECT COUNT(*) n FROM admin_audit WHERE action='issue_review'").get().n,1);
});

test('exception filters distinguish delayed tasks and credentials; pagination is bounded',async()=>{
 const env=environment(),admin=await administrator(env);await account(env,'A');env.db.prepare("UPDATE accounts SET needs_login=1 WHERE id='A'").run();
 for(let i=0;i<24;i++)addRun(env,'failed-'+i,'A','manual','failed');addRun(env,'slow','A');env.db.prepare("UPDATE runs SET updated_at=? WHERE id='slow'").run(time()-1000);
 const a=await (await api(env,'/api/zhuixins_x/issues',undefined,admin)).json(),b=await (await api(env,'/api/zhuixins_x/issues?page=1',undefined,admin)).json();assert.equal(a.issues.length,20);assert.equal(a.has_more,true);assert.equal(b.issues.length,6);
 for(const kind of ['credentials','delayed']){const d=await (await api(env,'/api/zhuixins_x/issues?filter='+kind,undefined,admin)).json();assert.equal(d.issues.length,1);assert.equal(d.issues[0].category,kind);}
 assert.equal((await api(env,'/api/zhuixins_x/issues?filter=bad',undefined,admin)).status,400);
});
