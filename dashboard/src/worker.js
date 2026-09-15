import html from './index.html';
import css from './style.css';
import client from './client.js.txt';
import {random, equal, seal, open, UserError, readText, utf8, b64} from './security.js';
import {loginZepp, validate} from './zepp.js';
import {query, limit, seconds, enqueue, scheduled, consume} from './jobs.js';
import {history} from './history.js';

const COOKIE = '__Host-mimotion-user-v2';
const json = (data, status=200) => new Response(JSON.stringify(data), {status,headers:{'content-type':'application/json; charset=utf-8'}});
const setCookie = (res, value, age=86400) => res.headers.append('Set-Cookie', `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${age}`);
export async function identity(env, text) {
  const key = await crypto.subtle.importKey('raw', utf8(env.MASTER_SECRET), {name:'HMAC',hash:'SHA-256'}, false, ['sign']);
  return b64(await crypto.subtle.sign('HMAC', key, utf8(text)));
}
async function session(request, env) {
  try {
    const value = request.headers.get('cookie')?.split(';').map(x=>x.trim()).find(x=>x.startsWith(COOKIE+'='))?.slice(COOKIE.length+1);
    const s = await open(value || '', env.MASTER_SECRET, 'user-session-v2');
    if (s.exp <= seconds() || !s.id || !s.csrf) return null;
    const account = await query(env, 'SELECT id,label,min_step,max_step,enabled,needs_login,session_version FROM accounts WHERE id=?', s.id).first();
    return account && account.session_version === s.version ? {...s, account} : null;
  } catch { return null; }
}
const publicAccount = a => ({label:a.label,min_step:a.min_step,max_step:a.max_step,enabled:!!a.enabled,needs_login:!!a.needs_login});
async function route(request, env) {
  const url = new URL(request.url), path = url.pathname;
  if (url.origin !== env.APP_ORIGIN) throw new UserError('访问地址不正确。', 403);
  if (!['GET','POST'].includes(request.method)) throw new UserError('不支持的请求。', 405);
  if (request.method === 'GET') {
    const assets = {'/':[html,'text/html'], '/setup':[html,'text/html'], '/style.css':[css,'text/css'], '/app.js':[client,'text/javascript']};
    if (assets[path]) return new Response(assets[path][0], {headers:{'content-type':assets[path][1]+'; charset=utf-8'}});
    if (path === '/favicon.ico') return new Response(null,{status:204});
  }
  let data;
  if (request.method === 'POST') {
    if (request.headers.get('Origin') !== env.APP_ORIGIN) throw new UserError('请求来源无效，请刷新页面。', 403);
    if (!request.headers.get('content-type')?.startsWith('application/json')) throw new UserError('请求格式无效。', 415);
    try { data = JSON.parse(await readText(request, 4096)); } catch { throw new UserError('请求内容无效或过大。', 400); }
    if (!data || Array.isArray(data) || typeof data !== 'object') throw new UserError('请求内容无效。');
  }
  if (path === '/api/login' && request.method === 'POST') {
    if (data.consent !== true) throw new UserError('请先同意保存加密登录凭据。');
    const v = validate(data);
    const ip = request.headers.get('CF-Connecting-IP') || 'local';
    await limit(env, 'login-global', 120, 3600);
    await limit(env, 'login-ip:' + await identity(env, ip), 8, 600);
    await limit(env, 'login-account:' + await identity(env, v.account.toLowerCase()), 5, 600);
    const verified = await loginZepp(data);
    const tokens = Object.values(verified.tokens)[0];
    const id = await identity(env, 'zepp-user:' + String(tokens.user_id));
    const version = random(), t = seconds();
    const result = await query(env, `INSERT INTO accounts(id,label,credentials,min_step,max_step,session_version,created_at,updated_at)
      SELECT ?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM accounts) < ? OR EXISTS(SELECT 1 FROM accounts WHERE id=?)
      ON CONFLICT(id) DO UPDATE SET credentials=excluded.credentials,label=excluded.label,
      session_version=excluded.session_version,needs_login=0,updated_at=excluded.updated_at
      WHERE accounts.lease_until < ?`, id, verified.summary.account, await seal(tokens, env.MASTER_SECRET, 'zepp:' + id), v.lo, v.hi, version, t, t, Number(env.MAX_ACCOUNTS || 200), id, t).run();
    if (!result.meta.changes) throw new UserError('账号正在执行任务，或站点注册名额已满，请稍后再试。', 409);
    const s = {id,version,csrf:random(),exp:t+86400};
    // Logging in schedules a read-only health check, never a step submission.
    try { await enqueue(env,{id,min_step:v.lo,max_step:v.hi},'check'); } catch { /* The user can retry from the test panel. */ }
    const res = json({ok:true}); setCookie(res, await seal(s, env.MASTER_SECRET, 'user-session-v2')); return res;
  }
  const s = await session(request, env);
  if (path === '/api/status' && request.method === 'GET') return json({signed_in:!!s,csrf:s?.csrf,account:s ? publicAccount(s.account) : null});
  if (!s) throw new UserError('请先登录自己的 Zepp Life 账号。', 401);
  if (request.method === 'POST' && !await equal(request.headers.get('X-CSRF-Token'), s.csrf)) throw new UserError('页面已过期，请刷新后重试。', 403);
  if (path === '/api/runs' && request.method === 'GET') {
    return json(await history(env,s.id,url));
  }
  if (request.method === 'POST') {
    await limit(env, 'write:' + s.id, 20, 60);
    if (path === '/api/check' || path === '/api/verify') {
      let source = null;
      if (path === '/api/verify') {
        if(typeof data.id !== 'string')throw new UserError('请选择要核对的执行记录。');
        source = await query(env, "SELECT id,day,step FROM runs WHERE id=? AND account_id=? AND kind IN ('manual','schedule') AND status IN ('success','unknown')", data.id,s.id).first();
        if(!source)throw new UserError('执行记录不存在或暂时无法核对。',404);
      }
      await limit(env,'check:'+s.id,1,60);
      return json({ok:true,id:await enqueue(env,s.account,source?'verify':'check',Date.now(),source)},202);
    }
    if (path === '/api/settings') {
      const v = validate({account:'validation@example.com',password:'unused',min_step:data.min_step,max_step:data.max_step});
      if (typeof data.enabled !== 'boolean') throw new UserError('请选择是否自动执行。');
      if (data.enabled && s.account.needs_login) throw new UserError('凭据已失效，请退出后重新登录。', 401);
      await query(env, 'UPDATE accounts SET min_step=?,max_step=?,enabled=?,updated_at=? WHERE id=?', v.lo,v.hi,Number(data.enabled),seconds(),s.id).run();
      return json({ok:true});
    }
    if (path === '/api/run') {
      if (s.account.needs_login) throw new UserError('凭据已失效，请退出后重新登录。', 401);
      await limit(env, 'run-minute:' + s.id, 1, 60);
      await limit(env, 'run-day:' + s.id, 6, 86400);
      return json({ok:true,id:await enqueue(env,s.account)},202);
    }
    if (path === '/api/delete') {
      if (data.confirm !== 'DELETE') throw new UserError('请确认删除当前账号。');
      const result = await query(env, 'DELETE FROM accounts WHERE id=? AND lease_until<?', s.id,seconds()).run();
      if (!result.meta.changes) throw new UserError('任务正在执行，请等待结束后再删除。',409);
      const res=json({ok:true});setCookie(res,'',0);return res;
    }
    if (path === '/api/logout') {
      await query(env, 'UPDATE accounts SET session_version=? WHERE id=? AND session_version=?', random(),s.id,s.version).run();
      const res=json({ok:true});setCookie(res,'',0);return res;
    }
  }
  throw new UserError('接口不存在。',404);
}
export default {
  async fetch(request, env) {
    let res;
    try { res=await route(request,env); }
    catch(e) {res=json({error:e instanceof UserError ? e.message : '服务暂时不可用，请稍后重试。'}, e instanceof UserError ? e.status : 503);}
    const headers = {'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY','Strict-Transport-Security':'max-age=31536000; includeSubDomains',
      'Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"};
    for(const [k,v] of Object.entries(headers)) res.headers.set(k,v);
    return res;
  },
  scheduled,
  async queue(batch, env) {for(const message of batch.messages) await consume(message,env);}
};
