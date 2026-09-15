import {seal, open, UserError} from './security.js';
import {refreshToken, submitSteps} from './steps.js';
import {readDaySteps, checkConnection, outcome, verificationText} from './verification.js';
import {requireMembership} from './licensing.js';
import {dispatch, armVerification, settleVerification} from './recovery.js';
export {scheduled} from './recovery.js';

export const seconds = () => Math.floor(Date.now() / 1000);
export const beijing = (ms = Date.now()) => new Date(ms + 8 * 3600000).toISOString();
export const query = (env, sql, ...args) => env.DB.prepare(sql).bind(...args);
export async function limit(env, id, maximum, window = 60) {
  const t = seconds(), bucket = Math.floor(t / window);
  const row = await query(env, `INSERT INTO rate_limits(id,count,expires_at) VALUES (?,1,?)
    ON CONFLICT(id) DO UPDATE SET count=count+1 RETURNING count`, `${id}:${bucket}`, (bucket + 1) * window).first();
  if (row.count > maximum) throw new UserError('操作过于频繁，请稍后再试。', 429);
}
export function targetSteps(lo, hi, ms = Date.now()) {
  const hour = Number(beijing(ms).slice(11, 13));
  const target = lo + crypto.getRandomValues(new Uint32Array(1))[0] % (hi - lo + 1);
  return Math.floor(target * Math.min(1, Math.max(0.05, (hour - 6) / 16)));
}
export async function enqueue(env, account, kind = 'manual', ms = Date.now(), source = null) {
  await requireMembership(env,account.id);
  const diagnostic = ['check','verify'].includes(kind);
  const day = source?.day || beijing(ms).slice(0, 10), t = seconds();
  const slot = kind === 'schedule' ? `schedule:${beijing(ms).slice(0, 13)}` : `${kind}:${source?.id || ''}:${Math.floor(t / 60)}`;
  const previous = await query(env, 'SELECT MAX(step) AS step FROM runs WHERE account_id=? AND day=? AND status IN (\'success\',\'unknown\',\'running\',\'queued\',\'pending\')', account.id, day).first();
  const step = diagnostic ? source?.step || 0 : Math.max(previous?.step || 0, targetSteps(account.min_step, account.max_step, ms));
  await query(env, `INSERT INTO runs(id,account_id,slot,kind,day,step,created_at,updated_at,parent_id)
    VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(account_id,slot) DO NOTHING`, crypto.randomUUID(), account.id, slot, kind, day, step, t, t, source?.id || null).run();
  const run = await query(env, 'SELECT id FROM runs WHERE account_id=? AND slot=?', account.id, slot).first();
  // D1 is the durable outbox. If sending fails, the next cron retries delivery.
  await dispatch(env, run.id);
  return run.id;
}
export async function consume(message, env) {
  let run = await query(env, 'SELECT * FROM runs WHERE id=?', String(message.body?.id || '')).first();
  if (!run || !['pending','queued'].includes(run.status)) { message.ack(); return; }
  if(run.next_attempt_at>seconds()){message.retry({delaySeconds:Math.min(86400,run.next_attempt_at-seconds())});return;}
  const finishUnclaimed=async(status,text)=>query(env,"UPDATE runs SET status=?,message=?,updated_at=?,finished_at=? WHERE id=? AND status IN ('pending','queued')",status,text,seconds(),seconds(),run.id).run();
  if(!['check','verify'].includes(run.kind)&&run.day!==beijing().slice(0,10)){await finishUnclaimed('skipped','任务已过期，未提交');message.ack();return;}
  const lease=crypto.randomUUID(),accountId=run.account_id;
  const locked=await query(env,'UPDATE accounts SET lease_id=?,lease_until=? WHERE id=? AND lease_until<?',lease,seconds()+300,run.account_id,seconds()).run();
  if(!locked.meta.changes){
    // Queue redelivery is bounded; the durable outbox recovers exhausted delivery later.
    message.retry({delaySeconds:90});return;
  }
  let claimed=false,writeStarted=false;
  const finish=async(status,text,error=null)=>query(env,'UPDATE runs SET status=?,message=?,error_code=?,updated_at=?,finished_at=? WHERE id=? AND execution_id=?',status,text,error,seconds(),seconds(),run.id,lease).run();
  try {
    // Refresh after acquiring the account lease; a concurrent delivery may have finished this job.
    run=await query(env,'SELECT * FROM runs WHERE id=?',run.id).first();
    if(!run||!['pending','queued'].includes(run.status))return;
    const account=await query(env,'SELECT * FROM accounts WHERE id=?',run.account_id).first();
    try{await requireMembership(env,run.account_id);}catch(e){if(!(e instanceof UserError))throw e;await finishUnclaimed('skipped',e.message);return;}
    if(account.needs_login||(run.kind==='schedule'&&!account.enabled)){await finishUnclaimed('skipped',account.needs_login?'凭据已过期，请重新登录':'自动执行已暂停');return;}
    // Additional invariant protects against any future outbox/recovery mistakes.
    if(!['check','verify'].includes(run.kind)&&run.phase!=='preparing'){await finishUnclaimed('unknown','此前已开始提交，将只读核对');await armVerification(env,run.id);return;}
    const result=await query(env,`UPDATE runs SET status='running',execution_id=?,attempt_count=attempt_count+1,message='正在验证凭据',started_at=?,updated_at=?,finished_at=NULL
      WHERE id=? AND status IN ('pending','queued') AND next_attempt_at<=?`,lease,seconds(),seconds(),run.id,seconds()).run();
    if(!result.meta.changes)return;
    claimed=true;run.attempt_count++;
    const tokens=await open(account.credentials,env.MASTER_SECRET,'zepp:'+account.id);
    try{await refreshToken(tokens);}catch(e){
      if(e instanceof UserError&&e.status===401)await query(env,'UPDATE accounts SET needs_login=1,enabled=0 WHERE id=? AND lease_id=?',account.id,lease).run();
      throw e;
    }
    await query(env,'UPDATE accounts SET credentials=?,updated_at=? WHERE id=? AND lease_id=?',await seal(tokens,env.MASTER_SECRET,'zepp:'+account.id),seconds(),account.id,lease).run();
    if(run.kind==='check'){
      await checkConnection(tokens);
      let observed=null;try{observed=await readDaySteps(tokens,run.day);}catch{}
      await query(env,'UPDATE runs SET observed_step=?,verification=?,checked_at=? WHERE id=? AND execution_id=?',observed,observed===null?'unavailable':'readable',seconds(),run.id,lease).run();
      await finish('success',observed===null?'账号连接正常；当天步数暂时不可读。本次未修改步数。':'账号连接正常，已读取当天步数。本次未修改步数。');return;
    }
    if(run.kind==='verify'){
      const source=await query(env,"SELECT * FROM runs WHERE id=? AND account_id=? AND kind IN ('manual','schedule') AND status IN ('success','unknown')",run.parent_id,account.id).first();
      if(!source){await finish('skipped','原执行记录不存在或无法核对');return;}
      if(run.auto_round&&source.verification==='matched'){await finish('skipped','此前已确认云端达到目标，无需再次查询');return;}
      let observed=null;try{observed=await readDaySteps(tokens,source.day);}catch(e){if(e.retryable)throw e;}
      const verified=outcome(observed,source.step),checked=seconds();
      // Keep waiting while another automatic check remains; matched evidence is not overwritten by an older check.
      await env.DB.batch([
        query(env,`UPDATE runs SET observed_step=?,verification=CASE WHEN ?='matched' THEN 'matched' WHEN EXISTS(SELECT 1 FROM runs child WHERE child.parent_id=runs.id AND child.id!=? AND child.auto_round>0 AND child.status IN ('pending','queued','running')) THEN 'waiting' ELSE ? END,checked_at=?
          WHERE id=? AND account_id=?`,observed,verified,run.id,verified,checked,source.id,account.id),
        query(env,'UPDATE runs SET observed_step=?,verification=?,checked_at=? WHERE id=? AND execution_id=?',observed,verified,checked,run.id,lease)
      ]);
      if(verified==='matched')await query(env,"UPDATE runs SET status='skipped',message='云端已达到目标，取消后续自动核对',finished_at=?,updated_at=? WHERE parent_id=? AND auto_round>0 AND status IN ('pending','queued')",seconds(),seconds(),source.id).run();
      await finish('success',verificationText(verified)+'。本次只查询，未重新提交。');return;
    }
    let before=null;try{before=await readDaySteps(tokens,run.day);}catch(e){if(e.retryable)throw e;}
    if(run.day!==beijing().slice(0,10)){await finish('skipped','已跨天，未提交');return;}
    const prior=await query(env,"SELECT MAX(step) AS step FROM runs WHERE account_id=? AND day=? AND status IN ('success','unknown')",account.id,run.day).first();
    run.step=Math.max(run.step,prior?.step||0,before||0);
    try{await requireMembership(env,account.id);}catch(e){if(!(e instanceof UserError))throw e;await finish('skipped',e.message);return;}
    // Fence and renew immediately before the ONLY write. Persist intent before sending.
    const fence=await query(env,'UPDATE accounts SET lease_until=? WHERE id=? AND lease_id=? AND lease_until>?',seconds()+300,account.id,lease,seconds()).run();
    if(!fence.meta.changes)throw new UserError('执行锁已失效，本次未提交。',409);
    if(run.day!==beijing().slice(0,10)){await finish('skipped','已跨天，未提交');return;}
    const intent=await query(env,"UPDATE runs SET phase='submitting',step=?,before_step=?,message='正在提交步数',updated_at=? WHERE id=? AND execution_id=? AND status='running' AND phase='preparing'",run.step,before,seconds(),run.id,lease).run();
    if(!intent.meta.changes)throw new UserError('任务状态已变化，本次未提交。',409);
    writeStarted=true;
    try{
      await submitSteps(tokens,run.step,run.day);
      await query(env,"UPDATE runs SET phase='accepted' WHERE id=? AND execution_id=?",run.id,lease).run();
      await finish('success','Zepp 已确认接收');
    }catch(e){
      await finish(e instanceof UserError&&e.status===422?'failed':'unknown',e instanceof UserError&&e.status===422?e.message:'未收到明确提交结果，将只读核对；不会自动重复提交',e.code||'submission_uncertain');
    }
    const submitted=await query(env,'SELECT status FROM runs WHERE id=?',run.id).first();
    if(['success','unknown'].includes(submitted.status)){
      let observed=null;try{observed=await readDaySteps(tokens,run.day);}catch{}
      await query(env,'UPDATE runs SET observed_step=?,verification=?,checked_at=? WHERE id=? AND execution_id=?',observed,outcome(observed,run.step),seconds(),run.id,lease).run();
      if(outcome(observed,run.step)!=='matched')await armVerification(env,run.id);
    }
  } catch(e){
    if(!claimed)throw e;
    if(writeStarted){
      // Includes a database failure AFTER a successful upstream POST. Never call it a safe failure.
      await query(env,"UPDATE runs SET status='unknown',message='提交结果待确认，将只读核对',error_code='submission_uncertain',updated_at=?,finished_at=? WHERE id=? AND execution_id=? AND status='running'",seconds(),seconds(),run.id,lease).run();
    }else if(e.retryable&&run.attempt_count<3){
      const delay=Math.max(e.retryAfter||0,run.attempt_count===1?30:120);
      await query(env,"UPDATE runs SET status='pending',message=?,error_code=?,delivered_at=0,next_attempt_at=?,updated_at=?,execution_id=NULL WHERE id=? AND execution_id=? AND phase='preparing'",'临时连接异常，等待安全重试（'+run.attempt_count+'/3）',e.code||'upstream_unavailable',seconds()+delay,seconds(),run.id,lease).run();
      await dispatch(env,run.id);
    }else await finish('failed',e instanceof UserError?e.message:'执行失败，请检查异常记录',e.code||(e.status===401?'credentials_expired':'execution_failed'));
  } finally {
    await query(env,'UPDATE accounts SET lease_id=NULL,lease_until=0 WHERE id=? AND lease_id=?',accountId,lease).run();
    await settleVerification(env);
  }
  message.ack();
}
