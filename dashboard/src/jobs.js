import {seal, open, UserError} from './security.js';
import {refreshToken, submitSteps} from './steps.js';
import {readDaySteps, checkConnection, outcome, verificationText} from './verification.js';

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
async function dispatch(env, id) {
  await query(env, "UPDATE runs SET status='queued',updated_at=? WHERE id=? AND status='pending'", seconds(), id).run();
  const row = await query(env, 'SELECT status FROM runs WHERE id=?', id).first();
  if (row?.status !== 'queued') return;
  try {
    await env.JOBS.send({id});
    await query(env, 'UPDATE runs SET delivered_at=? WHERE id=?', seconds(), id).run();
  }
  catch {
    await query(env, "UPDATE runs SET status='pending',message='排队暂时不可用，将自动重试',updated_at=? WHERE id=? AND status='queued'", seconds(), id).run();
  }
}
export async function scheduled(controller, env) {
  const ms = controller.scheduledTime, date = new Date(ms);
  if (date.getUTCMinutes() === 35 && [0,2,4,6,8,14].includes(date.getUTCHours())) {
    const local = beijing(ms), ratio = Math.min(1, Math.max(0.05, (Number(local.slice(11,13))-6)/16));
    await query(env, `INSERT INTO runs(id,account_id,slot,kind,day,step,created_at,updated_at)
      SELECT lower(hex(randomblob(16))),id,?,'schedule',?,CAST((min_step + abs(random() % (max_step-min_step+1))) * ? AS INTEGER),?,?
      FROM accounts WHERE enabled=1 AND needs_login=0 ON CONFLICT(account_id,slot) DO NOTHING`,
      'schedule:'+local.slice(0,13), local.slice(0,10), ratio, seconds(), seconds()).run();
  }
  // Never repeat an uncertain upstream POST after a worker interruption.
  await query(env, "UPDATE runs SET status='unknown',message='执行中断，结果待确认；请在 Zepp Life 查看',updated_at=? WHERE status='running' AND updated_at<?", seconds(), seconds() - 600).run();
  await query(env, "UPDATE runs SET verification='unavailable',checked_at=? WHERE verification='checking' AND updated_at<?", seconds(), seconds()-600).run();
  await query(env, "UPDATE runs SET status='failed',message='任务投递或执行超时，请手动重试',updated_at=? WHERE status='queued' AND created_at<?", seconds(), seconds()-86400).run();
  const {results} = await query(env, "SELECT id FROM runs WHERE status='pending' OR (status='queued' AND delivered_at=0 AND updated_at<?) ORDER BY created_at LIMIT 200", seconds() - 300).all();
  // Bulk delivery keeps one tick within D1's per-invocation query budget.
  for (let i=0; i<results.length; i+=50) {
    const ids = results.slice(i,i+50).map(r=>r.id), placeholders = ids.map(()=>'?').join(',');
    await query(env, `UPDATE runs SET status='queued',updated_at=? WHERE id IN (${placeholders}) AND status IN ('pending','queued')`, seconds(), ...ids).run();
    try {
      await env.JOBS.sendBatch(ids.map(id=>({body:{id}})));
      await query(env, `UPDATE runs SET delivered_at=? WHERE id IN (${placeholders})`, seconds(), ...ids).run();
    }
    catch {
      await query(env, `UPDATE runs SET status='pending' WHERE id IN (${placeholders}) AND status='queued'`, ...ids).run();
    }
  }
  if (date.getUTCHours() === 19 && date.getUTCMinutes() === 0) {
    await env.DB.batch([
      query(env, 'DELETE FROM rate_limits WHERE expires_at<?', seconds()),
      query(env, 'DELETE FROM runs WHERE created_at<?', seconds() - 30 * 86400),
    ]);
  }
}
export async function consume(message, env) {
  const run = await query(env, 'SELECT * FROM runs WHERE id=?', String(message.body?.id || '')).first();
  if (!run || !['pending','queued'].includes(run.status)) { message.ack(); return; }
  const finish = async (status, text) => query(env, 'UPDATE runs SET status=?,message=?,updated_at=?,finished_at=? WHERE id=?', status, text, seconds(), seconds(), run.id).run();
  if (!['check','verify'].includes(run.kind) && run.day !== beijing().slice(0, 10)) { await finish('skipped', '任务已过期，未提交'); message.ack(); return; }
  const lease = crypto.randomUUID();
  const result = await query(env, 'UPDATE accounts SET lease_id=?,lease_until=? WHERE id=? AND lease_until<?', lease, seconds() + 180, run.account_id, seconds()).run();
  if (!result.meta.changes) {
    if (message.attempts >= 3) { await query(env, "UPDATE runs SET status='skipped',message='同一账号还有任务执行，请稍后重试',updated_at=? WHERE id=? AND status IN ('pending','queued')", seconds(), run.id).run(); message.ack(); }
    else message.retry({delaySeconds: 90});
    return;
  }
  try {
    const account = await query(env, 'SELECT * FROM accounts WHERE id=?', run.account_id).first();
    if (account.needs_login || (run.kind === 'schedule' && !account.enabled)) {
      await finish('skipped', account.needs_login ? '凭据已过期，请重新登录' : '自动执行已暂停'); message.ack(); return;
    }
    const claim = await query(env, "UPDATE runs SET status='running',message='正在验证凭据',started_at=?,updated_at=? WHERE id=? AND status IN ('queued','pending')", seconds(), seconds(), run.id).run();
    if (!claim.meta.changes) { message.ack(); return; }
    const tokens = await open(account.credentials, env.MASTER_SECRET, 'zepp:' + account.id);
    try {
      await refreshToken(tokens);
    } catch (e) {
      if (e instanceof UserError && e.status === 401) {
        await query(env, 'UPDATE accounts SET needs_login=1,enabled=0 WHERE id=? AND lease_id=?', account.id, lease).run();
      }
      throw e;
    }
    await query(env, 'UPDATE accounts SET credentials=?,updated_at=? WHERE id=? AND lease_id=?', await seal(tokens, env.MASTER_SECRET, 'zepp:' + account.id), seconds(), account.id, lease).run();
    if (run.kind === 'check') {
      await checkConnection(tokens);
      let observed = null;
      try { observed = await readDaySteps(tokens, run.day); } catch { /* Connection and step readability are separate results. */ }
      await query(env, 'UPDATE runs SET observed_step=?,verification=?,checked_at=? WHERE id=?', observed, observed === null ? 'unavailable' : 'readable', seconds(), run.id).run();
      await finish('success', observed === null ? '账号连接正常；当天步数暂时不可读。本次未修改步数。' : '账号连接正常，已读取当天步数。本次未修改步数。');
      message.ack(); return;
    }
    if (run.kind === 'verify') {
      const source = await query(env, "SELECT * FROM runs WHERE id=? AND account_id=? AND kind IN ('manual','schedule') AND status IN ('success','unknown')", run.parent_id, account.id).first();
      if (!source) { await finish('skipped', '原执行记录不存在或无法核对'); message.ack(); return; }
      let observed = null;
      try { observed = await readDaySteps(tokens, source.day); } catch { /* Unavailable is not a failed submission. */ }
      const verified = outcome(observed, source.step), checked = seconds();
      await env.DB.batch([
        query(env, 'UPDATE runs SET observed_step=?,verification=?,checked_at=? WHERE id=? AND account_id=?', observed, verified, checked, source.id, account.id),
        query(env, 'UPDATE runs SET observed_step=?,verification=?,checked_at=? WHERE id=?', observed, verified, checked, run.id)
      ]);
      await finish('success', verificationText(verified) + '。本次只查询，未重新提交。');
      message.ack(); return;
    }
    let before = null;
    try { before = await readDaySteps(tokens, run.day); } catch { /* Keep baseline unavailable instead of fabricating zero. */ }
    await query(env, 'UPDATE runs SET before_step=?,message=? WHERE id=?', before, '正在提交步数', run.id).run();
    // Re-check the date immediately before the only mutating upstream request.
    if (run.day !== beijing().slice(0, 10)) { await finish('skipped', '已跨天，未提交'); message.ack(); return; }
    // A later queued run must not lower this service's previously submitted total.
    const prior = await query(env, "SELECT MAX(step) AS step FROM runs WHERE account_id=? AND day=? AND status IN ('success','unknown')", account.id, run.day).first();
    run.step = Math.max(run.step, prior?.step || 0, before || 0);
    await query(env, 'UPDATE runs SET step=? WHERE id=?', run.step, run.id).run();
    try {
      await submitSteps(tokens, run.step, run.day);
      await finish('success', 'Zepp 已确认接收');
    } catch (e) {
      await finish(e instanceof UserError && e.status === 422 ? 'failed' : 'unknown', e instanceof UserError && e.status === 422 ? e.message : '未收到明确结果，请在 Zepp Life 查看；不会自动重复提交');
    }
    // A readback failure must never change an accepted submission into a failure.
    const submitted = await query(env, 'SELECT status FROM runs WHERE id=?', run.id).first();
    if (['success','unknown'].includes(submitted.status)) {
      await query(env, "UPDATE runs SET verification='checking' WHERE id=?", run.id).run();
      let observed = null;
      try { observed = await readDaySteps(tokens, run.day); } catch { /* Record an explicit unavailable outcome. */ }
      await query(env, 'UPDATE runs SET observed_step=?,verification=?,checked_at=? WHERE id=?', observed, outcome(observed, run.step), seconds(), run.id).run();
    }
  } catch (e) {
    await query(env, "UPDATE runs SET status='failed',message=?,updated_at=? WHERE id=? AND status='running'", e instanceof UserError ? e.message : '执行失败，请稍后重试', seconds(), run.id).run();
  } finally {
    await query(env, 'UPDATE runs SET finished_at=? WHERE id=?', seconds(), run.id).run();
    await query(env, 'UPDATE accounts SET lease_id=NULL,lease_until=0 WHERE id=? AND lease_id=?', run.account_id, lease).run();
  }
  message.ack();
}
