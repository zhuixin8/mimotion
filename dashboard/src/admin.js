import {equal,open,seal,random,UserError} from './security.js';
import {hash} from './licensing.js';
import {verifyAdminPassword} from './admin-password.js';
import {query,limit,seconds} from './jobs.js';
const COOKIE='__Host-mimotion-admin-v1';
const json=data=>Response.json(data);
const cookie=(res,value,age=7200)=>res.headers.append('Set-Cookie',`${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${age}`);
export async function adminSession(req,env) {
  try {
    const raw=req.headers.get('cookie')?.split(';').map(s=>s.trim()).find(s=>s.startsWith(COOKIE+'='))?.slice(COOKIE.length+1);
    const s=await open(raw||'',env.MASTER_SECRET,'admin-session-v1');
    if(s.exp<=seconds()||s.role!=='owner'||!s.csrf)return null;
    const auth=await query(env,'SELECT version FROM admin_auth WHERE id=1').first();
    return auth?.version===s.version?s:null;
  }catch{return null;}
}
async function audit(env,action,target,details={}) {
  await query(env,'INSERT INTO admin_audit(id,actor,action,target,details,created_at) VALUES(?,?,?,?,?,?)',crypto.randomUUID(),'admin',action,target,JSON.stringify(details),seconds()).run();
}
function integer(v,min,max) {const n=Number(v);if(v===''||v===null||!['string','number'].includes(typeof v)||!Number.isSafeInteger(n)||n<min||n>max)throw new UserError(`请输入 ${min}–${max} 范围内的整数。`);return n;}
function page(url){return integer(url.searchParams.get('page')||0,0,10000);}
function text(v,max=100){if(typeof v!=='string'||v.length>max)throw new UserError('输入内容过长或格式无效。');return v.trim();}
export async function adminRoute(req,env,url,data) {
  const path=url.pathname;
  if(path==='/api/zhuixins_x/login'&&req.method==='POST'){
    await limit(env,'admin-login-global',30,3600);
    await limit(env,'admin-login:'+await hash(req.headers.get('CF-Connecting-IP')||'local'),5,600);
    const provided=typeof data.key==='string'&&data.key.length<=128?data.key.trim():'';
    const auth=await query(env,'SELECT key_hash,version FROM admin_auth WHERE id=1').first();
    if(!auth||!await verifyAdminPassword(provided,auth.key_hash))throw new UserError('管理员密码不正确。',401);
    const s={role:'owner',version:auth.version,csrf:random(),exp:seconds()+7200};
    await audit(env,'login','admin');
    const res=json({ok:true});cookie(res,await seal(s,env.MASTER_SECRET,'admin-session-v1'));return res;
  }
  const s=await adminSession(req,env);
  if(path==='/api/zhuixins_x/status'&&req.method==='GET')return json({signed_in:!!s,csrf:s?.csrf});
  if(!s)throw new UserError('请先登录管理后台。',401);
  if(req.method==='POST'){
    if(!await equal(req.headers.get('X-CSRF-Token'),s.csrf))throw new UserError('管理页面已过期，请刷新。',403);
    await limit(env,'admin-write',40,60);
  }
  if(path==='/api/zhuixins_x/overview'&&req.method==='GET'){
    const users=await query(env,'SELECT COUNT(*) total,COALESCE(SUM(expires_at>? AND suspended=0),0) active,COALESCE(SUM(suspended=1),0) suspended FROM memberships',seconds()).first();
    const codes=await query(env,'SELECT COUNT(*) total,COALESCE(SUM(redeemed_by IS NOT NULL),0) redeemed,COALESCE(SUM(redeemed_by IS NULL AND disabled=0 AND (valid_until IS NULL OR valid_until>?)),0) available FROM activation_codes',seconds()).first();
    return json({users,codes});
  }
  if(path==='/api/zhuixins_x/users'&&req.method==='GET'){
    const p=page(url),search=text(url.searchParams.get('search')||'');
    const {results}=await query(env,`SELECT m.account_id,m.expires_at,m.suspended,m.revision,m.created_at,
      a.label,a.enabled,a.needs_login,a.id IS NULL AS profile_deleted
      FROM memberships m LEFT JOIN accounts a ON a.id=m.account_id
      WHERE (?='' OR m.account_id=? OR instr(COALESCE(a.label,''),?)>0)
      ORDER BY m.created_at DESC,m.account_id DESC LIMIT 21 OFFSET ?`,search,search,search,p*20).all();
    return json({users:results.slice(0,20),has_more:results.length>20,page:p});
  }
  if(path==='/api/zhuixins_x/codes'&&req.method==='GET'){
    const p=page(url),status=url.searchParams.get('status')||'all';
    const conditions={all:'1=1',unused:'redeemed_by IS NULL AND disabled=0 AND (valid_until IS NULL OR valid_until>unixepoch())',used:'redeemed_by IS NOT NULL',disabled:'disabled=1',expired:'redeemed_by IS NULL AND valid_until<=unixepoch()'};
    if(!Object.hasOwn(conditions,status))throw new UserError('激活码筛选无效。');
    const {results}=await query(env,`SELECT id,hint,duration_days,batch_id,note,valid_until,disabled,redeemed_by,redeemed_at,created_at FROM activation_codes WHERE ${conditions[status]} ORDER BY created_at DESC,id DESC LIMIT 21 OFFSET ?`,p*20).all();
    return json({codes:results.slice(0,20),has_more:results.length>20,page:p});
  }
  if(path==='/api/zhuixins_x/audit'&&req.method==='GET'){
    const p=page(url),{results}=await query(env,'SELECT id,actor,action,target,details,created_at FROM admin_audit ORDER BY created_at DESC,id DESC LIMIT 21 OFFSET ?',p*20).all();
    return json({events:results.slice(0,20),has_more:results.length>20,page:p});
  }
  if(path==='/api/zhuixins_x/codes/create'&&req.method==='POST'){
    const days=integer(data.days,1,3650),count=integer(data.count,1,20),note=text(data.note||'');
    const validUntil=data.valid_until?integer(data.valid_until,seconds()+60,seconds()+3650*86400):null;
    const batch=crypto.randomUUID(),t=seconds(),codes=[],statements=[];
    for(let i=0;i<count;i++){
      const raw=Array.from(crypto.getRandomValues(new Uint8Array(16)),n=>n.toString(16).padStart(2,'0')).join('').toUpperCase();
      const code='MIM-'+raw.match(/.{8}/g).join('-'),id=crypto.randomUUID();
      statements.push(query(env,`INSERT INTO activation_codes(id,code_hash,hint,encrypted_code,duration_days,batch_id,note,valid_until,created_at) VALUES(?,?,?,?,?,?,?,?,?)`,id,await hash('activation:MIM'+raw),'MIM-…'+raw.slice(-8),await seal(code,env.MASTER_SECRET,'activation:'+id),days,batch,note,validUntil,t));
      codes.push({id,code,days,valid_until:validUntil});
    }
    statements.push(query(env,'INSERT INTO admin_audit(id,actor,action,target,details,created_at) VALUES(?,?,?,?,?,?)',crypto.randomUUID(),'admin','create_codes',batch,JSON.stringify({days,count,note}),t));
    await env.DB.batch(statements);return json({ok:true,batch_id:batch,codes});
  }
  if(path==='/api/zhuixins_x/codes/reveal'&&req.method==='POST'){
    const id=text(data.id,80),row=await query(env,'SELECT encrypted_code FROM activation_codes WHERE id=?',id).first();
    if(!row)throw new UserError('激活码不存在。',404);
    await audit(env,'reveal_code',id);return json({code:await open(row.encrypted_code,env.MASTER_SECRET,'activation:'+id)});
  }
  if(path==='/api/zhuixins_x/codes/revoke'&&req.method==='POST'){
    const id=text(data.id,80);
    await env.DB.batch([
      query(env,`INSERT INTO admin_audit(id,actor,action,target,details,created_at) SELECT ?,'admin','revoke_code',id,'{}',? FROM activation_codes WHERE id=? AND redeemed_by IS NULL AND disabled=0`,crypto.randomUUID(),seconds(),id),
      query(env,'UPDATE activation_codes SET disabled=1 WHERE id=? AND redeemed_by IS NULL AND disabled=0',id)
    ]);
    const row=await query(env,'SELECT redeemed_by,disabled FROM activation_codes WHERE id=?',id).first();
    if(!row||row.redeemed_by!==null)throw new UserError('已兑换的码不能停用；可在用户管理中调整权限。',409);
    return json({ok:true});
  }
  if(path==='/api/zhuixins_x/users/update'&&req.method==='POST'){
    const id=text(data.id,100),revision=integer(data.revision,1,100000000),reason=text(data.reason||'',200),mode=data.mode;
    if(!['extend','expiry','suspend','resume'].includes(mode))throw new UserError('管理操作无效。');
    const current=await query(env,'SELECT * FROM memberships WHERE account_id=?',id).first();
    if(!current)throw new UserError('用户不存在。',404);
    if(current.revision!==revision)throw new UserError('用户期限已变化，请刷新后重试。',409);
    let expiry=current.expires_at,suspended=current.suspended;
    if(mode==='extend')expiry=Math.max(expiry,seconds())+integer(data.days,1,3650)*86400;
    if(mode==='expiry')expiry=integer(data.expires_at,0,seconds()+36500*86400);
    if(mode==='suspend')suspended=1;if(mode==='resume')suspended=0;
    const result=await env.DB.batch([
      query(env,`INSERT INTO admin_audit(id,actor,action,target,details,created_at) SELECT ?,'admin',?,account_id,?,? FROM memberships WHERE account_id=? AND revision=?`,crypto.randomUUID(),'user_'+mode,JSON.stringify({previous_expiry:current.expires_at,new_expiry:expiry,suspended,reason}),seconds(),id,revision),
      query(env,'UPDATE memberships SET expires_at=?,suspended=?,revision=revision+1,updated_at=? WHERE account_id=? AND revision=?',expiry,suspended,seconds(),id,revision)
    ]);
    if(!result[1].meta.changes)throw new UserError('用户权限已变化，请刷新后重试。',409);
    return json({ok:true});
  }
  if(path==='/api/zhuixins_x/rotate-key'&&req.method==='POST'){
    if(data.confirm!==true)throw new UserError('请确认更换管理密钥。');
    const key=random(32),version=random();
    const result=await env.DB.batch([
      query(env,'UPDATE admin_auth SET key_hash=?,version=?,updated_at=? WHERE id=1 AND version=?',await hash('admin-key:'+key),version,seconds(),s.version),
      query(env,"INSERT INTO admin_audit(id,actor,action,target,details,created_at) SELECT ?,'admin','rotate_key','admin','{}',? FROM admin_auth WHERE id=1 AND version=?",crypto.randomUUID(),seconds(),version)
    ]);
    if(!result[0].meta.changes)throw new UserError('管理密钥已经变化，请重新登录。',409);
    const res=json({ok:true,key});cookie(res,'',0);return res;
  }
  if(path==='/api/zhuixins_x/logout'&&req.method==='POST'){
    await query(env,'UPDATE admin_auth SET version=? WHERE id=1 AND version=?',random(),s.version).run();
    const res=json({ok:true});cookie(res,'',0);return res;
  }
  throw new UserError('管理接口不存在。',404);
}
