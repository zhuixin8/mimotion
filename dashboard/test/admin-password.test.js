import test from 'node:test';
import assert from 'node:assert/strict';
import {hashAdminPassword,verifyAdminPassword} from '../src/admin-password.js';
import {hash} from '../src/licensing.js';

test('administrator password hashes use unique salts and require exact credentials',async()=>{
 const password='TEST-only-password.';
 const a=await hashAdminPassword(password),b=await hashAdminPassword(password);
 assert.notEqual(a,b);
 assert.equal(await verifyAdminPassword(password,a),true);
 assert.equal(await verifyAdminPassword(password.slice(0,-1),a),false);
 assert.equal(await verifyAdminPassword('wrong',a),false);
 for(const malformed of ['',null,'pbkdf2-sha256$1$AA==$AA==','pbkdf2-sha256$100000$bad$bad'])assert.equal(await verifyAdminPassword(password,malformed),false);
 assert.equal(await verifyAdminPassword('legacy-random-key',await hash('admin-key:legacy-random-key')),true);
});
