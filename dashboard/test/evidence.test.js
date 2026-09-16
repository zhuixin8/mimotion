import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseDayEvidence,parseMinuteSteps,evidenceOutcome} from '../src/verification.js';
import {minuteFixture} from './minute-fixture.js';
import {DatabaseSync} from 'node:sqlite';
const day='2026-09-16';
const row=(n,data)=>({date_time:day,summary:{stp:{ttl:n}},data});
test('real legacy template reproduces 8472 summary versus 125 minute inconsistency',()=>{
 const template=JSON.parse(readFileSync(new URL('../src/band-template.json',import.meta.url),'utf8'));
 const payload=Array.isArray(template)?template[0]:template;
 const evidence=parseDayEvidence({data:[row(8472,payload.data[0].value)]},day);
 assert.deepEqual(evidence,{summary:8472,detail:125,observed:null,state:'inconsistent'});
 assert.equal(evidenceOutcome(evidence,8472),'inconsistent');
});
test('3 and 8 byte minute data must agree with daily summary, including zero',()=>{
 for(const stride of [3,8])for(const n of [0,125,8472,50000]){
  const e=parseDayEvidence({data:[row(n,minuteFixture(n,stride))]},day);
  assert.equal(e.observed,n);assert.equal(evidenceOutcome(e,n),'matched');
 }
});
test('missing, malformed, ambiguous and wrong-date details cannot verify success',()=>{
 for(const raw of [undefined,'broken','',minuteFixture(1).slice(0,-4),'!'.repeat(5760)]){
  const e=parseDayEvidence({data:[row(8472,raw)]},day);
  assert.equal(e.observed,null);assert.notEqual(evidenceOutcome(e,1),'matched');
 }
 const r=row(8472,minuteFixture(8472));
 assert.equal(parseDayEvidence({data:[r,r]},day).state,'ambiguous');
 assert.equal(parseDayEvidence({data:[{...r,date_time:'2026-09-15'}]},day).observed,null);
 assert.equal(parseDayEvidence(null,day).observed,null);
 assert.equal(parseMinuteSteps('A'.repeat(20000)),null);
});
test('merged raw data and base64 summaries use the same consistency rules',()=>{
 const r={date:day,summary:btoa(JSON.stringify({stp:{ttl:125}})),mergedRawData:minuteFixture(125,8)};
 assert.equal(parseDayEvidence({data:[r]},day).observed,125);
});
test('migration preserves old summary numbers without promoting legacy waiting checks',()=>{
 const db=new DatabaseSync(':memory:');
 try{
  db.exec('CREATE TABLE runs(id TEXT,observed_step INTEGER,verification TEXT)');
  db.exec("INSERT INTO runs VALUES('old-success',8472,'matched'),('old-wait',8472,'waiting'),('empty',NULL,'unavailable')");
  db.exec(readFileSync(new URL('../migrations/0008_step_evidence.sql',import.meta.url),'utf8'));
  const success=db.prepare("SELECT * FROM runs WHERE id='old-success'").get();
  assert.equal(success.summary_step,8472);assert.equal(success.observed_step,null);assert.equal(success.verification,'summary_only');
  const wait=db.prepare("SELECT * FROM runs WHERE id='old-wait'").get();
  assert.equal(wait.evidence_state,'summary_only');assert.equal(wait.observed_step,null);assert.equal(wait.verification,'waiting');
 }finally{db.close();}
});
