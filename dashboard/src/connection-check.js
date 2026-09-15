import {query,seconds,beijing} from './jobs.js';
import {requireMembership} from './licensing.js';
import {dispatch} from './recovery.js';

// A single INSERT ... SELECT decides admission in D1. Concurrent logins and
// manual checks share an outstanding task instead of racing to enqueue two.
export async function connectionCheck(env,accountId,{force=false}={}) {
 await requireMembership(env,accountId);
 const t=seconds(),day=beijing().slice(0,10),id=crypto.randomUUID();
 const inserted=await query(env,`INSERT INTO runs(id,account_id,slot,kind,day,step,created_at,updated_at,message)
  SELECT ?,?,?,'check',?,0,?,?,'等待连接测试（只查询）'
  WHERE EXISTS(SELECT 1 FROM memberships WHERE account_id=? AND suspended=0 AND expires_at>?)
  AND NOT EXISTS(SELECT 1 FROM runs WHERE account_id=? AND kind='check' AND status IN ('pending','queued','running'))
  AND (?=1 OR NOT EXISTS(SELECT 1 FROM
    (SELECT status,finished_at,day FROM runs WHERE account_id=? AND kind='check' ORDER BY created_at DESC,rowid DESC LIMIT 1)
    WHERE status='success' AND finished_at>? AND day=?))`,
  id,accountId,'check:'+id,day,t,t,accountId,t,accountId,Number(force),accountId,t-1800,day).run();
 const row=inserted.meta.changes?{id}:await query(env,`SELECT id FROM runs WHERE account_id=? AND kind='check'
  ORDER BY CASE WHEN status IN ('pending','queued','running') THEN 0 ELSE 1 END,created_at DESC,rowid DESC LIMIT 1`,accountId).first();
 if(!row)return {state:'unavailable'};
 // dispatch is idempotent and keeps failed sends in the durable outbox.
 await dispatch(env,row.id);
 const current=await query(env,'SELECT id,status,finished_at,checked_at FROM runs WHERE id=? AND account_id=?',row.id,accountId).first();
 if(!current)return {state:'unavailable'};
 return {id:current.id,state:current.status==='success'?(inserted.meta.changes?'completed':'cached'):['pending','queued','running'].includes(current.status)?current.status:'unavailable',
  reused:!inserted.meta.changes,checked_at:current.checked_at||current.finished_at||null};
}
