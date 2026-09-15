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
  const response = await fetch(url, {...options, redirect: 'manual', signal: AbortSignal.timeout(20000)});
  const text = await readText(response);
  let data = {}; try { data = text ? JSON.parse(text) : {}; } catch {
    const type = (response.headers.get('Content-Type') || '').split(';')[0].toLowerCase();
    const kind = type === 'application/octet-stream' ? '二进制内容' : type === 'text/html' ? '网页内容' : '非 JSON 内容';
    // Expose only the stage, status and content category, never body text or tokens.
    throw new UserError(`${label}返回了${kind}（HTTP ${response.status}），暂时无法完成请求。`, 502);
  }
  return {response, data};
}
