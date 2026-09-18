import {minuteFixture} from './minute-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {seal} from '../src/security.js';
import {connectionCheck} from '../dist/worker.js';

test('workerd + D1 + queue: actual delivery, durable delayed checks and duplicate safety',{timeout:25000},async()=>{
 const day=new Date(Date.now()+28800000).toISOString().slice(0,10),now=Math.floor(Date.now()/1000);let posts=0,observed=null;
 const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'app',modules:true,script:readFileSync(new URL('../dist/worker.js',import.meta.url),'utf8'),compatibilityDate:'2026-09-15',compatibilityFlags:['nodejs_compat'],
  bindings:{APP_ORIGIN:'https://local.test',MASTER_SECRET:'runtime-test-only',MAX_ACCOUNTS:'200'},d1Databases:['DB'],queueProducers:{JOBS:'jobs'},queueConsumers:{jobs:{maxBatchSize:1,maxBatchTimeout:0,maxRetries:3,deadLetterQueue:'dead'}},
  outboundService:async req=>{
   const url=new URL(req.url);
   if(url.pathname.includes('getUserInfo.json'))return Response.json({message:'success'});
   if(url.pathname.includes('/app_tokens'))return Response.json({result:'ok',token_info:{app_token:'refreshed-test'}});
   if(url.pathname.includes('/band_data')){
    if(req.method==='POST'){posts++;return Response.json({message:'success'});}
    if(observed===null)return Response.json({message:'success',data:[]});
    return Response.json({message:'success',data:[{date:day,data:minuteFixture(observed),summary:{stp:{ttl:observed}}}]});
   }
   throw new Error('Unexpected outbound request');
  }
 }]}));
 try{
  const db=await mf.getD1Database('DB'),schema=new DatabaseSync(':memory:');
  for(const name of readdirSync(new URL('../migrations/',import.meta.url)).filter(n=>n.endsWith('.sql')).sort())schema.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
  for(const {sql} of schema.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all())await db.prepare(sql).run();
  schema.close();
  await db.prepare('INSERT INTO site_settings(id,updated_at,new_user_gift_days) VALUES(1,?,7)').bind(now).run();
  await db.prepare('INSERT INTO memberships(account_id,created_at,updated_at) VALUES(?,?,?) ON CONFLICT(account_id) DO NOTHING').bind('gift-test',now,now).run();
  await db.prepare('INSERT INTO memberships(account_id,created_at,updated_at) VALUES(?,?,?) ON CONFLICT(account_id) DO NOTHING').bind('gift-test',now+10,now+10).run();
  const gifted=await db.prepare("SELECT * FROM memberships WHERE account_id='gift-test'").first();assert.equal(gifted.expires_at,now+7*86400);assert.equal(gifted.registration_gift_days,7);
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM admin_audit WHERE action='registration_gift'").first()).n,1);
  await db.prepare('INSERT INTO accounts(id,label,credentials,enabled,session_version,created_at,updated_at) VALUES(?,?,?,0,?,?,?)').bind('A','test',await seal({user_id:'A',login_token:'test'},'runtime-test-only','zepp:A'),'v',now,now).run();
  await db.prepare('INSERT INTO memberships(account_id,expires_at,created_at,updated_at) VALUES(?,?,?,?)').bind('A',now+86400,now,now).run();
  await db.prepare("INSERT INTO runs(id,account_id,slot,kind,day,step,status,created_at,updated_at) VALUES('r','A','r','manual',?,20000,'queued',?,?)").bind(day,now,now).run();
  const queue=await mf.getQueueProducer('JOBS');await queue.send({id:'r'});
  let source;
  for(let i=0;i<60;i++){source=await db.prepare("SELECT * FROM runs WHERE id='r'").first();if(source.verification==='waiting')break;await new Promise(r=>setTimeout(r,100));}
  assert.equal(source.status,'success');assert.equal(source.phase,'accepted');assert.equal(source.verification,'waiting');assert.equal(posts,1);
  const {results:children}=await db.prepare("SELECT * FROM runs WHERE parent_id='r' ORDER BY auto_round").all();assert.equal(children.length,1);assert.ok(children[0].next_attempt_at>=now+300);
  const app=await mf.getWorker(),delivery=id=>({id:crypto.randomUUID(),timestamp:new Date(),attempts:1,body:{id}});
  const early=await app.queue('jobs',[delivery(children[0].id)]);assert.equal(early.retryMessages.length,1);assert.equal(posts,1);
  observed=25000;await db.prepare('UPDATE runs SET next_attempt_at=0 WHERE id=?').bind(children[0].id).run();await app.queue('jobs',[delivery(children[0].id)]);
  assert.equal((await db.prepare("SELECT verification FROM runs WHERE id='r'").first()).verification,'matched');
  await app.queue('jobs',[delivery('r'),delivery(children[0].id)]);assert.equal(posts,1);
  const sent=[],diagnosticEnv={DB:db,JOBS:{send:async body=>sent.push(body)}};
  const diagnostics=await Promise.all([connectionCheck(diagnosticEnv,'A'),connectionCheck(diagnosticEnv,'A',{force:true})]);
  assert.equal(diagnostics[0].id,diagnostics[1].id);assert.equal(sent.length,1);
  await db.prepare("UPDATE runs SET status='success',finished_at=?,checked_at=? WHERE id=?").bind(now,now,diagnostics[0].id).run();
  assert.equal((await connectionCheck(diagnosticEnv,'A')).state,'cached');assert.equal(sent.length,1);
 }finally{await mf.dispose();}
});
