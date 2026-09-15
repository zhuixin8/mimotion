import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../dist/worker.js';

const env = {APP_ORIGIN:'https://s.dqai.cc', LEGACY_ORIGIN:'https://mimotion-dashboard.113618446.workers.dev'};

test('custom domain serves pages and redirects only legacy navigation', async () => {
  for (const path of ['/', '/setup', '/admin', '/admin/']) {
    const current = await worker.fetch(new Request(env.APP_ORIGIN + path), env);
    assert.equal(current.status, 200);
    const old = await worker.fetch(new Request(env.LEGACY_ORIGIN + path + '?token=discard'), env);
    assert.equal(old.status, 302);
    assert.equal(old.headers.get('Location'), env.APP_ORIGIN + path);
  }
});

test('domain migration never redirects API requests or accepts foreign origins', async () => {
  for (const request of [
    new Request(env.LEGACY_ORIGIN + '/api/status'),
    new Request(env.LEGACY_ORIGIN + '/api/login', {method:'POST'}),
    new Request('https://unknown.example/admin'),
    new Request(env.APP_ORIGIN + '/api/admin/login', {method:'POST', headers:{Origin:env.LEGACY_ORIGIN, 'Content-Type':'application/json'}, body:'{}'})
  ]) {
    const res = await worker.fetch(request, env);
    assert.equal(res.status, 403);
    assert.equal(res.headers.get('Location'), null);
  }
});
