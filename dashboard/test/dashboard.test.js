import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../dist/worker.js';
import {seal, open, aesCBC, b64, utf8, unb64, fetchJSON} from '../src/security.js';
import {validate} from '../src/zepp.js';
import {encryptSecret, saveConfig} from '../src/github.js';
import nacl from 'tweetnacl';
import sealedbox from 'tweetnacl-sealedbox-js';

const origin = 'https://mimotion.test';
function environment() {
  const map = new Map();
  return {APP_ORIGIN: origin, MASTER_SECRET: 'test-only-master-secret', BOOTSTRAP_TOKEN: 'test-only-bootstrap', GITHUB_OWNER_ID: '48154595', GITHUB_OWNER: 'zhuixin8', GITHUB_REPO: 'zhuixin8/mimotion', STORE: {get: async key => map.get(key) || null, put: async (key, value) => map.set(key, value), delete: async key => map.delete(key)}, map};
}
async function auth(env, overrides = {}) {
  const s = {id: 48154595, login: 'zhuixin8', token: 'private-user-token', sid: 'test-session', csrf: 'test-csrf', exp: Math.floor(Date.now() / 1000) + 600, ...overrides};
  return {s, cookie: '__Host-mimotion-session=' + await seal(s, env.MASTER_SECRET, 'session')};
}
function req(path, data, cookie = '', headers = {}) {
  return new Request(origin + path, {method: data === undefined ? 'GET' : 'POST', headers: {Cookie: cookie, Origin: origin, 'Content-Type': 'application/json', 'X-CSRF-Token': 'test-csrf', ...headers}, ...(data === undefined ? {} : {body: JSON.stringify(data)})});
}
test('encrypted envelopes reject tampering and cross-purpose reuse', async () => {
  const text = await seal({password: 'private'}, 'test-key', 'session');
  assert.ok(!text.includes('private')); assert.deepEqual(await open(text, 'test-key', 'session'), {password: 'private'});
  await assert.rejects(open(text, 'test-key', 'draft')); await assert.rejects(open(text, 'different-key', 'session'));
});
test('Zepp CBC format is IV + padded ciphertext and decrypts with Web Crypto', async () => {
  const value = await aesCBC('token-cache', 'abcdefghijklmnop');
  const key = await crypto.subtle.importKey('raw', utf8('abcdefghijklmnop'), 'AES-CBC', false, ['decrypt']);
  const result = await crypto.subtle.decrypt({name: 'AES-CBC', iv: value.slice(0, 16)}, key, value.slice(16));
  assert.equal(new TextDecoder().decode(result), 'token-cache');
});
test('GitHub secrets use a sealed box readable only with the receiver key', () => {
  const pair = nacl.box.keyPair(); const result = encryptSecret('CONFIG-secret', b64(pair.publicKey));
  assert.equal(new TextDecoder().decode(sealedbox.open(unb64(result), pair.publicKey, pair.secretKey)), 'CONFIG-secret');
});
test('validation rejects mixed accounts, invalid steps and unsupported password delimiter', () => {
  const good = {account: '13800138000', password: 'ok', min_step: 1, max_step: 2};
  assert.equal(validate(good).account, '+8613800138000');
  for (const update of [{account: 'a#b'}, {min_step: 3}, {max_step: 1.5}, {password: 'a#b'}, {min_step: ''}]) assert.throws(() => validate({...good, ...update}));
});
test('unauthenticated, expired, wrong owner, wrong origin and CSRF requests cannot write', async () => {
  const env = environment();
  assert.equal((await worker.fetch(req('/api/config/save', {}), env)).status, 401);
  for (const overrides of [{id: 123}, {exp: 1}]) { const a = await auth(env, overrides); assert.equal((await worker.fetch(req('/api/config/save', {}, a.cookie), env)).status, 401); }
  const a = await auth(env);
  assert.equal((await worker.fetch(req('/api/config/save', {}, a.cookie, {Origin: 'https://evil.test'}), env)).status, 403);
  assert.equal((await worker.fetch(req('/api/config/save', {}, a.cookie, {'X-CSRF-Token': 'bad'}), env)).status, 403);
  assert.equal(env.map.size, 0);
});
test('setup requires bootstrap capability and does not expose secrets in response', async () => {
  const env = environment();
  assert.equal((await worker.fetch(req('/api/setup/start', {token: 'wrong'}), env)).status, 403);
  const response = await worker.fetch(req('/api/setup/start', {token: env.BOOTSTRAP_TOKEN}), env);
  const result = await response.json(); const manifest = JSON.parse(result.manifest);
  assert.equal(manifest.public, false); assert.deepEqual(manifest.default_permissions, {actions: 'write', secrets: 'write', metadata: 'read'});
  assert.ok(response.headers.get('Set-Cookie').includes('HttpOnly; Secure; SameSite=Lax'));
  assert.ok(!JSON.stringify(result).includes(env.BOOTSTRAP_TOKEN));
});
test('Zepp 401 is actionable and never leaves a valid draft', async () => {
  const env = environment(), a = await auth(env), previous = globalThis.fetch;
  globalThis.fetch = async () => new Response('', {status: 303, headers: {Location: 'https://example.test/?error=401'}});
  try {
    const response = await worker.fetch(req('/api/zepp/login', {account: 'test@example.com', password: 'password-private', min_step: 1, max_step: 2}, a.cookie), env);
    assert.equal(response.status, 422); const text = await response.text(); assert.ok(text.includes('401')); assert.ok(!text.includes('password-private')); assert.equal(env.map.get('draft:test-session'), undefined);
  } finally { globalThis.fetch = previous; }
});
test('successful login obtains all credentials and stores only encrypted expiring draft', async () => {
  const env = environment(), a = await auth(env), previous = globalThis.fetch; const urls = [];
  globalThis.fetch = async (url, options) => { urls.push(String(url));
    if (String(url).includes('/registrations/')) {
      assert.equal(new Headers(options.headers).get('x-hm-ekv'), '1');
      return new Response('', {status: 303, headers: {Location: 'https://example.test/?access=access-private&next=1'}});
    }
    if (String(url).includes('/client/login')) {
      // Reproduce Zepp's actual behavior: this header changes the response to binary.
      if (new Headers(options.headers).has('x-hm-ekv')) return new Response(new Uint8Array([248, 0, 241]), {status: 400, headers: {'Content-Type': 'application/octet-stream'}});
      assert.ok(options.body instanceof URLSearchParams);
      return Response.json({result: 'ok', token_info: {login_token: 'login-private', app_token: 'app-private', user_id: '123'}});
    }
    return Response.json({items: [{deviceType: 0, deviceId: 'AA:BB'}]});
  };
  try {
    const response = await worker.fetch(req('/api/zepp/login', {account: 'test@example.com', password: 'password-private', min_step: 1, max_step: 2}, a.cookie), env);
    assert.equal(response.status, 200); const text = await response.text(); assert.ok(!text.includes('private')); assert.ok(!text.includes('test@example.com'));
    const stored = env.map.get('draft:test-session'); assert.ok(stored && !stored.includes('password-private'));
    const draft = await open(stored, env.MASTER_SECRET, 'draft:test-session');
    assert.equal(draft.config.PWD, 'password-private'); assert.equal(draft.tokens['test@example.com'].bound_device_id, 'AABB'); assert.ok(draft.exp > Date.now() / 1000);
    assert.ok(urls.every(url => !url.includes('band_data')));
  } finally { globalThis.fetch = previous; }
});
test('non-JSON errors identify the endpoint and status without exposing response secrets', async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => new Response('private-upstream-token', {status: 400, headers: {'Content-Type': 'application/octet-stream'}});
  try {
    await assert.rejects(fetchJSON('https://example.test/', {}, 'Zepp 客户端授权接口'), error => {
      assert.match(error.message, /Zepp 客户端授权接口/);
      assert.match(error.message, /HTTP 400/);
      assert.match(error.message, /二进制/);
      assert.ok(!error.message.includes('private-upstream-token'));
      return true;
    });
  } finally { globalThis.fetch = previous; }
});
test('save encrypts each secret and reports partial failure without dispatching', async () => {
  const env = environment(), pair = nacl.box.keyPair(), previous = globalThis.fetch; const writes = [];
  const prepared = {config: {USER: 'user', PWD: 'secret'}, aes_key: 'abcdefghijklmnop', tokens: {user: {app_token: 'app-private'}}};
  globalThis.fetch = async (url, opts) => {
    if (String(url).endsWith('/public-key')) return Response.json({key: b64(pair.publicKey), key_id: 'key1'});
    if (String(url).endsWith('/run.yml')) return Response.json({state: 'active'});
    if (opts.method === 'PUT') { writes.push({url: String(url), body: JSON.parse(opts.body)}); return new Response(null, {status: writes.length === 2 ? 403 : 204}); }
    if (opts.method === 'POST') throw new Error('must not dispatch');
    return Response.json({default_branch: 'master'});
  };
  try {
    await assert.rejects(saveConfig(env, 'github-private', prepared), /已确认保存：AES_KEY/);
    assert.equal(writes.length, 2); assert.equal(writes[0].body.key_id, 'key1');
    assert.equal(new TextDecoder().decode(sealedbox.open(unb64(writes[0].body.encrypted_value), pair.publicKey, pair.secretKey)), prepared.aes_key);
    assert.ok(!JSON.stringify(writes).includes('app-private'));
  } finally { globalThis.fetch = previous; }
});
