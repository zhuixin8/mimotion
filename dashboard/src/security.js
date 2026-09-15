const enc = new TextEncoder();
export const utf8 = value => enc.encode(value);
export const b64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)));
export const unb64 = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));
export const random = (size = 32) => b64(crypto.getRandomValues(new Uint8Array(size))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
export async function equal(a, b) {
  const [x, y] = await Promise.all([a, b].map(v => crypto.subtle.digest('SHA-256', utf8(String(v ?? '')))));
  const xa = new Uint8Array(x), ya = new Uint8Array(y);
  let diff = 0; for (let i = 0; i < xa.length; i++) diff |= xa[i] ^ ya[i];
  return diff === 0;
}
async function key(secret) {
  return crypto.subtle.importKey('raw', await crypto.subtle.digest('SHA-256', utf8(secret)), 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function seal(value, secret, purpose) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({name: 'AES-GCM', iv, additionalData: utf8(purpose)}, await key(secret), utf8(JSON.stringify(value)));
  return b64(iv) + '.' + b64(data);
}
export async function open(value, secret, purpose) {
  const [iv, data] = value.split('.');
  const raw = await crypto.subtle.decrypt({name: 'AES-GCM', iv: unb64(iv), additionalData: utf8(purpose)}, await key(secret), unb64(data));
  return JSON.parse(new TextDecoder().decode(raw));
}
export async function aesCBC(text, secret, suppliedIV) {
  const iv = suppliedIV ? utf8(suppliedIV) : crypto.getRandomValues(new Uint8Array(16));
  const k = await crypto.subtle.importKey('raw', utf8(secret), 'AES-CBC', false, ['encrypt']);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({name: 'AES-CBC', iv}, k, utf8(text)));
  return suppliedIV ? encrypted : new Uint8Array([...iv, ...encrypted]);
}
export class UserError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export class UpstreamError extends UserError {
  constructor(message, code, retryable = false, retryAfter = 0) {
    super(message, 502); this.code = code; this.retryable = retryable; this.retryAfter = retryAfter;
  }
}
export async function readText(response, limit = 1024 * 1024) {
  if (!response.body) return '';
  const reader = response.body.getReader(); let length = 0; const chunks = [];
  try {
    while (true) { const {done, value} = await reader.read(); if (done) break;
      length += value.length; if (length > limit) { await reader.cancel(); throw new UserError('返回内容过大，请稍后重试。', 502); } chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const all = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(all);
}
export async function fetchJSON(url, options = {}, label = '远端服务') {
  const safe = (options.method || 'GET').toUpperCase() === 'GET';
  for (let attempt = 0; ; attempt++) {
    try {
      let response, text;
      try {
        response = await fetch(url, {...options, redirect: 'manual', signal: AbortSignal.timeout(20000)});
        if (response.status === 429 || response.status === 408 || response.status >= 500) {
          const raw = response.headers.get('retry-after');
          const delay = raw === null ? 0 : /^\d+$/.test(raw) ? Number(raw) : Math.max(0, Math.ceil((Date.parse(raw) - Date.now()) / 1000));
          await response.body?.cancel();
          throw new UpstreamError(`${label}${response.status === 429 ? '请求受限' : '暂时不可用'}（HTTP ${response.status}），稍后重试。`, response.status === 429 ? 'rate_limited' : 'upstream_unavailable', true, Number.isFinite(delay) ? Math.min(delay,86400) : 0);
        }
        text = await readText(response);
      } catch (e) {
        if (e instanceof UserError) throw e;
        throw new UpstreamError(`${label}网络连接中断或超时。`, 'network_timeout', true);
      }
      let data = {}; try { data = text ? JSON.parse(text) : {}; } catch {
        const type = (response.headers.get('Content-Type') || '').split(';')[0].toLowerCase();
        const kind = type === 'application/octet-stream' ? '二进制内容' : type === 'text/html' ? '网页内容' : '非 JSON 内容';
        throw new UpstreamError(`${label}返回了${kind}（HTTP ${response.status}），暂时无法完成请求。`, 'response_format');
      }
      return {response, data};
    } catch (e) {
      // Retry reads once. A POST is never automatically repeated, including on timeout.
      if (!safe || !e.retryable || attempt >= 1 || e.retryAfter > 2) throw e;
      await new Promise(resolve => setTimeout(resolve, Math.max(e.retryAfter * 1000, 250 + Math.floor(Math.random()*250))));
    }
  }
}
