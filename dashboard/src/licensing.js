import {UserError, utf8} from './security.js';
const q=(env,sql,...args)=>env.DB.prepare(sql).bind(...args);
const now=()=>Math.floor(Date.now()/1000);
export async function hash(value) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',utf8(value))),n=>n.toString(16).padStart(2,'0')).join('');
}
export async function membership(env,id) {
  const row=await q(env,'SELECT expires_at,suspended,revision FROM memberships WHERE account_id=?',id).first();
  const expires=row?.expires_at||0,suspended=!!row?.suspended;
  return {expires_at:expires,suspended,revision:row?.revision||0,active:!suspended&&expires>now(),remaining_seconds:Math.max(0,expires-now())};
}
export async function requireMembership(env,id) {
  const access=await membership(env,id);
  if(access.suspended)throw new UserError('账号已被管理员停用，请联系管理员。',403);
  if(!access.active)throw new UserError('服务尚未激活或已到期，请先兑换激活码。',403);
  return access;
}
export function normalizeCode(value) {
  if(typeof value!=='string'||value.length>100)throw new UserError('请输入有效的激活码。');
  const code=value.trim().toUpperCase().replaceAll('-','').replaceAll(' ','');
  if(!/^MIM[0-9A-F]{32}$/.test(code))throw new UserError('激活码格式不正确。');
  return code;
}
export async function redeem(env,id,value) {
  const codeHash=await hash('activation:'+normalizeCode(value)),t=now();
  // The trigger adds time and writes the ledger in the same transaction as claim.
  const claim=await q(env, `UPDATE activation_codes SET redeemed_by=?,redeemed_at=?
    WHERE code_hash=? AND redeemed_by IS NULL AND disabled=0 AND (valid_until IS NULL OR valid_until>?)
    AND EXISTS(SELECT 1 FROM memberships WHERE account_id=? AND suspended=0)`,id,t,codeHash,t,id).run();
  const code=await q(env,'SELECT id,redeemed_by FROM activation_codes WHERE code_hash=?',codeHash).first();
  if(!code||code.redeemed_by!==id)throw new UserError('激活码无效、已兑换、已停用或已过兑换期限；账号停用时也无法兑换。',409);
  const receipt=await q(env,'SELECT duration_days,previous_expiry,new_expiry,created_at FROM license_redemptions WHERE code_id=? AND account_id=?',code.id,id).first();
  return {ok:true,already_redeemed:!claim.meta.changes,receipt,membership:await membership(env,id)};
}
export async function licenseHistory(env,id) {
  const {results}=await q(env,`SELECT r.duration_days,r.previous_expiry,r.new_expiry,r.created_at,c.hint
    FROM license_redemptions r JOIN activation_codes c ON c.id=r.code_id WHERE r.account_id=? ORDER BY r.created_at DESC,r.code_id DESC LIMIT 30`,id).all();
  return {membership:await membership(env,id),redemptions:results};
}
