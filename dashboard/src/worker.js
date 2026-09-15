import html from './index.html';
import css from './style.css';
import client from './client.js.txt';
import {random, equal, seal, open, UserError, fetchJSON, readText} from './security.js';
import {github, saveConfig} from './github.js';
import {loginZepp} from './zepp.js';

const now = () => Math.floor(Date.now() / 1000);
const json = (data, status = 200) => new Response(JSON.stringify(data), {status, headers: {'Content-Type': 'application/json; charset=utf-8'}});
const cookieName = kind => '__Host-mimotion-' + kind;
function cookie(request, kind) { return request.headers.get('Cookie')?.split(';').map(v => v.trim()).find(v => v.startsWith(cookieName(kind) + '='))?.slice(cookieName(kind).length + 1); }
function setCookie(response, kind, value, age) { response.headers.append('Set-Cookie', `${cookieName(kind)}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`); }
function redirect(url) { return new Response(null, {status: 303, headers: {Location: url}}); }
async function appConfig(env) { const value = await env.STORE.get('app-config'); return value ? open(value, env.MASTER_SECRET, 'app-config') : null; }
async function session(request, env) {
  try {
    const result = await open(cookie(request, 'session') || '', env.MASTER_SECRET, 'session');
    if (result.exp < now() || String(result.id) !== env.GITHUB_OWNER_ID) throw new Error();
    return result;
  } catch { throw new UserError('请先使用 GitHub 登录。', 401); }
}
async function body(request) {
  if (!(request.headers.get('Content-Type') || '').startsWith('application/json')) throw new UserError('请求格式无效。', 415);
  try { const parsed = JSON.parse(await readText(request, 16384)); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(); return parsed; }
  catch (e) { if (e instanceof UserError) throw e; throw new UserError('请求格式无效。'); }
}
async function protectedPost(request, env) {
  const s = await session(request, env);
  if (!await equal(s.csrf, request.headers.get('X-CSRF-Token'))) throw new UserError('页面验证已失效，请刷新后重试。', 403);
  return s;
}
async function getDraft(env, s) {
  const value = await env.STORE.get('draft:' + s.sid);
  if (!value) throw new UserError('登录配置已过期，请重新验证 Zepp 账号。', 409);
  const draft = await open(value, env.MASTER_SECRET, 'draft:' + s.sid);
  if (draft.exp < now()) throw new UserError('登录配置已过期，请重新验证 Zepp 账号。', 409);
  return draft;
}
async function route(request, env) {
  const url = new URL(request.url), path = url.pathname;
  if (url.origin !== env.APP_ORIGIN) throw new UserError('请使用正式页面地址访问。', 403);
  if (!['GET', 'POST'].includes(request.method)) throw new UserError('不支持此请求。', 405);
  if (request.method === 'POST' && request.headers.get('Origin') !== env.APP_ORIGIN) throw new UserError('请求来源无效。', 403);
  if (request.method === 'GET' && ['/', '/setup'].includes(path)) return new Response(html, {headers: {'Content-Type': 'text/html; charset=utf-8'}});
  if (request.method === 'GET' && path === '/style.css') return new Response(css, {headers: {'Content-Type': 'text/css; charset=utf-8'}});
  if (request.method === 'GET' && path === '/app.js') return new Response(client, {headers: {'Content-Type': 'text/javascript; charset=utf-8'}});
  if (request.method === 'GET' && path === '/favicon.svg') return new Response('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#143eee"/><path d="M12 39l11-17 10 22 11-25 8 17" fill="none" stroke="white" stroke-width="5" stroke-linejoin="round"/></svg>', {headers: {'Content-Type': 'image/svg+xml'}});
  if (!env.MASTER_SECRET) throw new UserError('网页尚未完成初始化。', 503);
  if (request.method === 'GET' && path === '/api/status') {
    const config = await appConfig(env);
    let s = null; try { s = await session(request, env); } catch {}
    let draft = null; if (s) { try { draft = await getDraft(env, s); } catch {} }
    return json({configured: !!config, signed_in: !!s, login: s?.login, csrf: s?.csrf, summary: draft?.summary,
      install_url: config ? `https://github.com/apps/${config.slug}/installations/new` : null, repository: env.GITHUB_REPO});
  }
  if (request.method === 'POST' && path === '/api/setup/start') {
    if (await appConfig(env)) throw new UserError('GitHub 应用已经创建，请直接登录。', 409);
    const data = await body(request);
    if (!env.BOOTSTRAP_TOKEN || !await equal(data.token, env.BOOTSTRAP_TOKEN)) throw new UserError('初始化链接无效。请使用专属初始化链接。', 403);
    const state = random();
    const manifest = {name: 'mimotion-zhuixin8-' + crypto.randomUUID().slice(0, 8), url: env.APP_ORIGIN,
      hook_attributes: {url: env.APP_ORIGIN + '/webhook', active: false},
      redirect_url: env.APP_ORIGIN + '/setup/callback', callback_urls: [env.APP_ORIGIN + '/auth/callback'],
      setup_url: env.APP_ORIGIN + '/auth/start', public: false, request_oauth_on_install: false,
      description: '个人 Zepp Life 配置面板，仅管理 mimotion 的配置和工作流。', default_permissions: {actions: 'write', secrets: 'write', metadata: 'read'}, default_events: []};
    const response = json({action: 'https://github.com/settings/apps/new?state=' + state, manifest: JSON.stringify(manifest)});
    setCookie(response, 'setup', await seal({state, exp: now() + 1800}, env.MASTER_SECRET, 'setup'), 1800);
    return response;
  }
  if (request.method === 'GET' && path === '/setup/callback') {
    if (await appConfig(env)) return redirect('/auth/start');
    let state; try { state = await open(cookie(request, 'setup') || '', env.MASTER_SECRET, 'setup'); } catch { throw new UserError('初始化会话已过期，请重新打开初始化链接。', 403); }
    if (state.exp < now() || !await equal(state.state, url.searchParams.get('state'))) throw new UserError('初始化验证失败。', 403);
    const code = url.searchParams.get('code'); if (!code || !/^[a-zA-Z0-9_-]+$/.test(code)) throw new UserError('GitHub 未返回注册结果。');
    const app = await github('/app-manifests/' + encodeURIComponent(code) + '/conversions', null, 'POST');
    if (String(app.owner?.id) !== env.GITHUB_OWNER_ID) throw new UserError('请在 zhuixin8 账号下创建应用。', 403);
    if (!app.client_id || !app.client_secret || !app.slug) throw new UserError('GitHub 返回的应用信息不完整。', 502);
    // The app private key is unnecessary for user-authorized requests and is deliberately not retained.
    await env.STORE.put('app-config', await seal({client_id: app.client_id, client_secret: app.client_secret, slug: app.slug, id: app.id}, env.MASTER_SECRET, 'app-config'));
    const response = redirect(`https://github.com/apps/${app.slug}/installations/new`); setCookie(response, 'setup', '', 0); return response;
  }
  if (request.method === 'GET' && path === '/auth/start') {
    const app = await appConfig(env); if (!app) throw new UserError('请先创建专属 GitHub 应用。', 409);
    const state = random();
    const response = redirect('https://github.com/login/oauth/authorize?' + new URLSearchParams({client_id: app.client_id, redirect_uri: env.APP_ORIGIN + '/auth/callback', state, login: env.GITHUB_OWNER}));
    setCookie(response, 'oauth', await seal({state, exp: now() + 600}, env.MASTER_SECRET, 'oauth'), 600); return response;
  }
  if (request.method === 'GET' && path === '/auth/callback') {
    let oauth; try { oauth = await open(cookie(request, 'oauth') || '', env.MASTER_SECRET, 'oauth'); } catch { throw new UserError('登录会话已过期，请返回首页重新登录。', 403); }
    if (oauth.exp < now() || !await equal(oauth.state, url.searchParams.get('state'))) throw new UserError('GitHub 登录验证失败，请重试。', 403);
    const code = url.searchParams.get('code'); if (!code) throw new UserError('你尚未完成 GitHub 授权，请返回首页重试。');
    const app = await appConfig(env);
    const {response: remote, data} = await fetchJSON('https://github.com/login/oauth/access_token', {method: 'POST', headers: {Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'mimotion-dashboard'}, body: JSON.stringify({client_id: app.client_id, client_secret: app.client_secret, code, redirect_uri: env.APP_ORIGIN + '/auth/callback'})});
    if (!remote.ok || !data.access_token) throw new UserError('GitHub 授权没有完成，请重试。', 401);
    const user = await github('/user', data.access_token);
    if (String(user.id) !== env.GITHUB_OWNER_ID) throw new UserError('此页面仅允许 zhuixin8 使用。', 403);
    const s = {id: user.id, login: user.login, token: data.access_token, sid: random(), csrf: random(), exp: now() + 3600};
    const response = redirect('/'); setCookie(response, 'session', await seal(s, env.MASTER_SECRET, 'session'), 3600); setCookie(response, 'oauth', '', 0); return response;
  }
  if (request.method === 'POST' && path === '/api/logout') {
    const s = await protectedPost(request, env); await env.STORE.delete('draft:' + s.sid);
    const response = json({ok: true}); setCookie(response, 'session', '', 0); return response;
  }
  if (request.method === 'POST' && path === '/api/zepp/login') {
    const s = await protectedPost(request, env); const data = await body(request);
    const last = Number(await env.STORE.get('login-at:' + s.sid)); if (last && now() - last < 15) throw new UserError('请等待 15 秒再尝试登录。', 429);
    await env.STORE.put('login-at:' + s.sid, String(now()), {expirationTtl: 60});
    await env.STORE.delete('draft:' + s.sid);
    const prepared = await loginZepp(data); prepared.exp = now() + 600;
    await env.STORE.put('draft:' + s.sid, await seal(prepared, env.MASTER_SECRET, 'draft:' + s.sid), {expirationTtl: 600});
    return json({ok: true, summary: prepared.summary});
  }
  if (request.method === 'POST' && path === '/api/config/save') {
    const s = await protectedPost(request, env); const data = await body(request);
    if (data.replace_config !== true) throw new UserError('请确认以本次单账号设置替换仓库配置。');
    const prepared = await getDraft(env, s); const result = await saveConfig(env, s.token, prepared);
    await env.STORE.delete('draft:' + s.sid); return json(result);
  }
  if (request.method === 'GET' && path === '/api/runs') {
    const s = await session(request, env);
    const data = await github('/repos/' + env.GITHUB_REPO + '/actions/workflows/run.yml/runs?per_page=5', s.token);
    return json({runs: (data.workflow_runs || []).map(r => ({id: r.id, status: r.status, conclusion: r.conclusion, created_at: r.created_at, url: r.html_url}))});
  }
  throw new UserError('页面不存在。', 404);
}
export default {
  async fetch(request, env) {
    let response;
    try { response = await route(request, env); }
    catch (e) {
      const message = e instanceof UserError ? e.message : '连接远端服务失败，请稍后重试。';
      response = json({ok: false, message}, e instanceof UserError ? e.status : 502);
      // Never log request bodies, URLs, upstream error objects, or authentication material.
    }
    response.headers.set('Cache-Control', 'no-store');
    response.headers.set('Referrer-Policy', 'no-referrer');
    response.headers.set('X-Content-Type-Options', 'nosniff');
    response.headers.set('X-Frame-Options', 'DENY');
    response.headers.set('Strict-Transport-Security', 'max-age=31536000');
    response.headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self' https://github.com");
    return response;
  }
};
