import {open,seal,random,UserError} from './security.js';
import {query,seconds,limit} from './jobs.js';
import {loginZepp,validate} from './zepp.js';
import {refreshToken} from './steps.js';

// Reconnect only the current identity. Never enroll another account or replay a job.
export async function reconnect(env,s,data,identity,passwordLogin){
  if(passwordLogin&&data.consent!==true)throw new UserError('请确认重新验证可能影响手机 App 登录。');
  if(passwordLogin)validate({...data,min_step:s.account.min_step,max_step:s.account.max_step});
  await limit(env,'reconnect:'+s.id,3,600);
  if(passwordLogin)await limit(env,'login-global',120,3600);
  const lease=crypto.randomUUID(),now=seconds();
  const lock=await query(env,`UPDATE accounts SET lease_id=?,lease_until=? WHERE id=? AND session_version=? AND lease_until<?
    AND NOT EXISTS(SELECT 1 FROM runs WHERE account_id=? AND status IN ('pending','queued','running'))`,lease,now+180,s.id,s.version,now,s.id).run();
  if(!lock.meta.changes)throw new UserError('账号有任务正在执行或页面已过期，请稍后刷新重试。',409);
  try{
    let tokens;
    if(passwordLogin){
      const result=await loginZepp({...data,min_step:s.account.min_step,max_step:s.account.max_step});
      tokens=Object.values(result.tokens)[0];
      if(await identity(env,'zepp-user:'+String(tokens.user_id))!==s.id)throw new UserError('输入的账号不是当前账号，未替换凭据。切换账号请先退出登录。',409);
    }else{
      const a=await query(env,'SELECT credentials FROM accounts WHERE id=? AND lease_id=?',s.id,lease).first();
      tokens=await open(a.credentials,env.MASTER_SECRET,'zepp:'+s.id);
      await refreshToken(tokens);
    }
    const next={id:s.id,version:random(),csrf:random(),exp:seconds()+86400};
    const changed=await query(env,'UPDATE accounts SET credentials=?,needs_login=0,session_version=?,updated_at=? WHERE id=? AND lease_id=? AND session_version=? AND lease_until>?',await seal(tokens,env.MASTER_SECRET,'zepp:'+s.id),next.version,seconds(),s.id,lease,s.version,seconds()).run();
    if(!changed.meta.changes)throw new UserError('登录状态已变化，请刷新页面。',409);
    return next;
  }catch(e){
    if(e instanceof UserError&&e.status===401)await query(env,'UPDATE accounts SET needs_login=1,enabled=0 WHERE id=? AND lease_id=? AND session_version=?',s.id,lease,s.version).run();
    throw e;
  }finally{
    await query(env,'UPDATE accounts SET lease_id=NULL,lease_until=0 WHERE id=? AND lease_id=?',s.id,lease).run();
  }
}
