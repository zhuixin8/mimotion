import {query, seconds, beijing} from './jobs.js';
import {SCHEDULE_UTC_HOURS} from './schedule.js';

export async function dispatch(env, id) {
  const row = await query(env, `UPDATE runs SET status='queued',delivered_at=?,delivery_count=delivery_count+1,updated_at=?
    WHERE id=? AND status IN ('pending','queued') AND delivery_count<4 AND (status='pending' OR delivered_at=0)
    RETURNING id,next_attempt_at`, seconds(), seconds(), id).first();
  if (!row) return;
  try { await env.JOBS.send({id}, {delaySeconds:Math.max(0,Math.min(86400,row.next_attempt_at-seconds()))}); }
  catch { await query(env,"UPDATE runs SET status='pending',delivered_at=0,message='排队暂时不可用，将自动恢复' WHERE id=? AND status='queued'",id).run(); }
}

// Two durable, read-only follow-ups. D1 batch makes their creation and parent state atomic.
export async function armVerification(env, id = null) {
  const t=seconds(), filter=`kind IN ('manual','schedule') AND status IN ('success','unknown') AND verification!='matched'
    AND auto_checks_scheduled=0 ${id?'AND id=?':''}`;
  const args=id?[id]:[];
  await env.DB.batch([
    ...[1,2].map(round=>query(env,`INSERT INTO runs(id,account_id,slot,kind,day,step,parent_id,auto_round,next_attempt_at,created_at,updated_at,message)
      SELECT lower(hex(randomblob(16))),account_id,'auto-verify:'||id||':${round}','verify',day,step,id,${round},?,?,?,'等待自动核对（只查询）'
      FROM runs WHERE ${filter} ON CONFLICT(account_id,slot) DO NOTHING`,t+(round===1?30:120),t,t,...args)),
    query(env,`UPDATE runs SET auto_checks_scheduled=1,verification='waiting' WHERE ${filter}`, ...args)
  ]);
  if(id){
    const {results}=await query(env,"SELECT id FROM runs WHERE parent_id=? AND auto_round>0 AND status='pending'",id).all();
    for(const r of results)await dispatch(env,r.id);
  }
}

export async function settleVerification(env) {
  await query(env,`UPDATE runs SET verification=CASE WHEN evidence_state='inconsistent' THEN 'inconsistent' WHEN evidence_state='summary_only' THEN 'summary_only' WHEN observed_step IS NULL THEN 'unavailable' WHEN observed_step>=step THEN 'matched' ELSE 'below_target' END
    WHERE verification='waiting' AND NOT EXISTS(SELECT 1 FROM runs child WHERE child.parent_id=runs.id AND child.auto_round>0 AND child.status IN ('pending','queued','running'))`).run();
}

export async function scheduled(controller, env) {
  const ms=controller.scheduledTime, date=new Date(ms), t=seconds();
  // Catch up only the most recent slot within 30 minutes, never a previous Beijing day.
  const start=Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),date.getUTCDate());
  const slot=SCHEDULE_UTC_HOURS.map(h=>start+h*3600000+35*60000).find(s=>s<=ms&&ms-s<=30*60000);
  if(slot!==undefined){
    const local=beijing(slot),ratio=Math.min(1,Math.max(0.05,(Number(local.slice(11,13))-6)/16));
    await query(env,`INSERT INTO runs(id,account_id,slot,kind,day,step,created_at,updated_at)
      SELECT lower(hex(randomblob(16))),id,?,'schedule',?,CAST((min_step+abs(random()%(max_step-min_step+1)))*? AS INTEGER),?,?
      FROM accounts WHERE enabled=1 AND needs_login=0 AND EXISTS(SELECT 1 FROM memberships m WHERE m.account_id=accounts.id AND m.suspended=0 AND m.expires_at>unixepoch())
      ON CONFLICT(account_id,slot) DO NOTHING`,'schedule:'+local.slice(0,13),local.slice(0,10),ratio,t,t).run();
  }
  // Fenced recovery: only expired executions may be reclaimed. Uncertain writes are never requeued.
  await query(env,`UPDATE runs SET status=CASE WHEN phase IN ('submitting','accepted') OR execution_id IS NULL THEN 'unknown' WHEN attempt_count<3 THEN 'pending' ELSE 'failed' END,
    message=CASE WHEN phase IN ('submitting','accepted') OR execution_id IS NULL THEN '执行中断，提交结果待确认；将只读核对' WHEN attempt_count<3 THEN '提交前中断，等待安全重试' ELSE '执行恢复次数已用尽，请检查异常记录' END,
    error_code='execution_interrupted',execution_id=NULL,delivered_at=0,next_attempt_at=?,updated_at=?,finished_at=CASE WHEN phase IN ('submitting','accepted') OR execution_id IS NULL OR attempt_count>=3 THEN ? ELSE NULL END
    WHERE status='running' AND updated_at<? AND EXISTS(SELECT 1 FROM accounts a WHERE a.id=runs.account_id AND a.lease_until<?)`,t,t,t,t-600,t).run();
  await query(env,`UPDATE runs SET status='failed',message='投递恢复次数已用尽或任务已超时，请检查异常记录',error_code='delivery_exhausted',updated_at=?,finished_at=?
    WHERE status IN ('pending','queued') AND (created_at<? OR (delivery_count>=4 AND MAX(delivered_at,next_attempt_at,updated_at)<?))`,t,t,t-86400,t-900).run();
  await query(env,`UPDATE runs SET status='pending',delivered_at=0,message='队列处理延迟，等待自动恢复',error_code='delivery_delayed',updated_at=?
    WHERE status='queued' AND delivery_count<4 AND MAX(delivered_at,next_attempt_at,updated_at)<?`,t,t-900).run();
  await armVerification(env);
  await settleVerification(env);
  // Bulk outbox claims bound query counts at 200 accounts. Delays are persisted in D1.
  const {results}=await query(env,`SELECT id,next_attempt_at FROM runs WHERE delivery_count<4 AND
    (status='pending' OR (status='queued' AND delivered_at=0)) ORDER BY next_attempt_at,created_at LIMIT 200`).all();
  for(let i=0;i<results.length;i+=50){
    const rows=results.slice(i,i+50),ids=rows.map(r=>r.id),p=ids.map(()=>'?').join(',');
    const claimed=await query(env,`UPDATE runs SET status='queued',delivered_at=?,delivery_count=delivery_count+1,updated_at=?
      WHERE id IN (${p}) AND delivery_count<4 AND (status='pending' OR (status='queued' AND delivered_at=0)) RETURNING id,next_attempt_at`,t,t,...ids).all();
    if(!claimed.results.length)continue;
    try { await env.JOBS.sendBatch(claimed.results.map(r=>({body:{id:r.id},delaySeconds:Math.max(0,Math.min(86400,r.next_attempt_at-t))}))); }
    catch { const sentIds=claimed.results.map(r=>r.id);await query(env,`UPDATE runs SET status='pending',delivered_at=0 WHERE id IN (${sentIds.map(()=>'?').join(',')}) AND status='queued' AND delivered_at=?`,...sentIds,t).run(); }
  }
  if(date.getUTCHours()===19&&date.getUTCMinutes()===0)await env.DB.batch([
    query(env,'DELETE FROM rate_limits WHERE expires_at<?',t),query(env,'DELETE FROM runs WHERE created_at<?',t-30*86400)
  ]);
}
