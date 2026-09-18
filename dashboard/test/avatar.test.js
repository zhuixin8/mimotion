import test from 'node:test';
import assert from 'node:assert/strict';
import {gunzipSync} from 'node:zlib';
import {avatarState} from '../src/avatar-state.js';
import worker from '../dist/worker.js';
test('avatar follows saved plan and fresh task state without claiming successful synchronization',()=>{
 const now=Date.now(),account={enabled:true,membership:{active:true,expires_at:now/1000+86400}},runtime={latest:{status:'success'}};
 assert.equal(avatarState(account,runtime,now,now).motion,'walk');
 assert.equal(avatarState({...account,enabled:false},runtime,now,now).animate,false);
 assert.equal(avatarState(account,runtime,now,now).animate,true);
 assert.equal(avatarState(account,{latest:{status:'running'}},now,now).animate,true);
 assert.equal(avatarState({...account,enabled:false},{latest:{status:'running'}},now,now).motion,'run');
 assert.equal(avatarState(account,{latest:{status:'queued'}},now,now).motion,'walk');
 assert.equal(avatarState(account,{latest:{status:'running'}},now-91000,now).motion,'idle');
 for(const a of [{...account,needs_login:true},{...account,membership:{active:false}},{...account,membership:{active:true,suspended:true}},{...account,membership:{active:true,expires_at:now/1000-1}}])assert.equal(avatarState(a,{latest:{status:'running'}},now,now).motion,'idle');
 assert.equal(avatarState(account,null,0,now).motion,'idle');
});
test('avatar static resources are local, cacheable and do not require DB access; APIs remain uncached',async()=>{
 const env={APP_ORIGIN:'https://test.example'},get=p=>worker.fetch(new Request(env.APP_ORIGIN+p),env);
 const js=await get('/athlete-v4.js');assert.equal(js.status,200);assert.match(js.headers.get('cache-control'),/immutable/);assert.match(js.headers.get('content-type'),/javascript/);assert.ok(!(await js.text()).includes('esm.sh/'));
 const model=await get('/athlete-model-v1.glb.gz');assert.equal(model.status,200);assert.match(model.headers.get('cache-control'),/immutable/);
 const bytes=gunzipSync(Buffer.from(await model.arrayBuffer()));assert.equal(bytes.toString('ascii',0,4),'glTF');const json=JSON.parse(bytes.toString('utf8',20,20+bytes.readUInt32LE(12)));assert.deepEqual(json.animations.map(a=>a.name).sort(),['idle','run','walk']);assert.ok(json.images.every(i=>i.bufferView!==undefined&&!i.uri));
 const status=await get('/api/status');assert.equal(status.headers.get('cache-control'),'no-store');assert.equal((await status.json()).signed_in,false);
 assert.match((await get('/')).headers.get('content-security-policy'),/script-src 'self';/);
});
