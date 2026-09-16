import test from 'node:test';
import assert from 'node:assert/strict';
import {selectBoundDevice,readBoundDevice} from '../src/devices.js';
import {loginZepp} from '../src/zepp.js';

const record={uid:'owner',device_type:0,deviceid:'AABBCCDDEEFF1234'};
test('device selection verifies owner, format and ambiguity without exposing device secrets',()=>{
 assert.equal(selectBoundDevice({code:1,data:[{...record,auth_key:'private'}]},'owner'),record.deviceid);
 assert.equal(selectBoundDevice({code:1,data:[record]},'other'),null);
 for(const data of [[],[{...record,device_type:1}],[{...record,deviceid:'bad'}],[record,{...record,deviceid:'1122334455667788'}]])assert.equal(selectBoundDevice({code:1,data},'owner'),null);
 for(const data of [{code:0,data:[]},{code:1,data:{}},{}])assert.throws(()=>selectBoundDevice(data,'owner'),e=>e.code==='response_format');
});
test('bound device lookup uses the list GET endpoint and keeps credentials out of the URL',async(t)=>{
 t.mock.method(globalThis,'fetch',async(url,opts)=>{
  const parsed=new URL(url);assert.equal(parsed.pathname,'/v1/device/lists.json');assert.equal(parsed.searchParams.get('userid'),'owner');assert.equal(parsed.searchParams.get('enableMultiDevice'),'true');
  assert.equal(opts.method||'GET','GET');assert.equal(opts.body,undefined);assert.ok(!String(url).includes('private-token'));
  assert.equal(new Headers(opts.headers).get('apptoken'),'private-token');return Response.json({code:1,data:[record]});
 });
 assert.equal(await readBoundDevice({user_id:'owner',app_token:'private-token'}),record.deviceid);
});
test('login retains a verified bound device and never sends a binding request',async(t)=>{
 t.mock.method(globalThis,'fetch',async(url,opts)=>{
  if(String(url).includes('/registrations/tokens'))return new Response(null,{status:303,headers:{Location:'https://example.test/?access=dummy'}});
  if(String(url).includes('/v2/client/login'))return Response.json({result:'ok',token_info:{user_id:'owner',login_token:'dummy',app_token:'dummy'}});
  assert.ok(String(url).includes('/device/lists.json'));assert.equal(opts.method||'GET','GET');return Response.json({code:1,data:[record]});
 });
 const result=await loginZepp({account:'owner@example.com',password:'dummy',min_step:1,max_step:2});
 const tokens=Object.values(result.tokens)[0];assert.equal(tokens.bound_device_id,record.deviceid);assert.equal(tokens.bound_device_source,'zepp-account');assert.equal(result.summary.device_found,true);
});
