import {query,seconds} from './jobs.js';
import {UserError} from './security.js';
import {siteSettings} from './site.js';
import {history} from './history.js';
import {membership} from './licensing.js';

function str(v,max,required=false){if(typeof v!=='string'||v.length>max||(required&&!v.trim()))throw new UserError('输入内容为空或过长。');return v.trim();}
function integer(v,max=100000000){const n=Number(v);if(v===null||v===''||!Number.isSafeInteger(n)||n<0||n>max)throw new UserError('参数无效。');return n;}
const stamp="r.status||':'||r.verification||':'||r.updated_at||':'||COALESCE(r.checked_at,0)";
const runIssue="(r.status IN ('failed','unknown') OR r.verification IN ('below_target','unavailable') OR (r.status IN ('pending','queued','running') AND r.updated_at < unixepoch()-900))";
const kind="CASE WHEN r.status='unknown' THEN 'unknown' WHEN r.status IN ('pending','queued','running') THEN 'delayed' WHEN r.status='failed' THEN 'failed' ELSE 'unverified' END";
const advice={credentials:'请联系用户重新登录 Zepp Life，再开启自动计划。',unknown:'提交结果不确定。请用户先在执行记录中重新核对或查看 Zepp，不要直接重复提交。',delayed:'检查队列与任务时间。正在执行的任务不要重复提交；等待状态更新后再判断。',failed:'先查看错误信息；凭据问题需重新登录，网络问题可先测试连接。',unverified:'提交或连接可能已成功，但云端读数尚未确认。请用户稍后进行只读核对。'};
const issueQuery=`SELECT r.id,r.account_id,a.label,${kind} AS category,r.status,r.verification,r.message,r.error_code,r.day,r.step,r.observed_step,r.updated_at,${stamp} AS stamp,
 COALESCE(v.revision,0) AS review_revision,COALESCE(v.note,'') AS review_note,COALESCE(v.updated_at,0) AS reviewed_at,CASE WHEN v.stamp=(${stamp}) THEN 1 ELSE 0 END AS handled
 FROM runs r JOIN accounts a ON a.id=r.account_id LEFT JOIN issue_reviews v ON v.run_id=r.id WHERE ${runIssue}
 UNION ALL SELECT a.id,a.id,a.label,'credentials','needs_login','not_checked','Zepp 登录凭据已失效','credentials_expired',NULL,NULL,NULL,a.updated_at,'',0,'',0,0 FROM accounts a WHERE a.needs_login=1`;

export async function adminOperations(req,env,url,data){
 const path=url.pathname.slice('/api/zhuixins_x/'.length);
 if(path==='site'&&req.method==='GET')return Response.json(await siteSettings(env));
 if(path==='site'&&req.method==='POST'){
  const name=str(data.name,40,true),announcement=str(data.announcement,500),contact=str(data.contact,150),revision=integer(data.revision);
  if(typeof data.registration_open!=='boolean')throw new UserError('请选择是否开放注册。');
  const r=await query(env,'UPDATE site_settings SET name=?,announcement=?,contact=?,registration_open=?,revision=revision+1,updated_at=? WHERE id=1 AND revision=?',name,announcement,contact,Number(data.registration_open),seconds(),revision).run();
  if(!r.meta.changes)throw new UserError('站点设置已被更新，请刷新后重试。',409);
  return Response.json({ok:true,settings:await siteSettings(env)});
 }
 if(path==='users/detail'&&req.method==='GET'){
  const id=str(url.searchParams.get('id'),100,true),m=await query(env,'SELECT account_id,expires_at,suspended,revision,created_at,updated_at FROM memberships WHERE account_id=?',id).first();
  if(!m)throw new UserError('用户不存在。',404);
  const account=await query(env,'SELECT id,label,min_step,max_step,enabled,needs_login,created_at,updated_at FROM accounts WHERE id=?',id).first();
  const note=await query(env,'SELECT note,revision,updated_at FROM user_notes WHERE account_id=?',id).first()||{note:'',revision:0,updated_at:0};
  const h=await history(env,id,new URL('https://local.test/'));
  const redemptions=await query(env,'SELECT l.duration_days,l.created_at,l.new_expiry,c.hint FROM license_redemptions l JOIN activation_codes c ON c.id=l.code_id WHERE l.account_id=? ORDER BY l.created_at DESC,l.code_id DESC LIMIT 20',id).all();
  const events=await query(env,'SELECT action,details,created_at FROM admin_audit WHERE target=? ORDER BY created_at DESC,id DESC LIMIT 20',id).all();
  return Response.json({member:m,access:await membership(env,id),account,note,runtime:h.runtime,runs:h.runs,runs_has_more:h.has_more,redemptions:redemptions.results,events:events.results});
 }
 if(path==='users/note'&&req.method==='POST'){
  const id=str(data.id,100,true),note=str(data.note,600),revision=integer(data.revision);
  if(!await query(env,'SELECT account_id FROM memberships WHERE account_id=?',id).first())throw new UserError('用户不存在。',404);
  const r=await query(env,`INSERT INTO user_notes(account_id,note,revision,updated_at) SELECT ?,?,1,? WHERE COALESCE((SELECT revision FROM user_notes WHERE account_id=?),0)=?
   ON CONFLICT(account_id) DO UPDATE SET note=excluded.note,revision=user_notes.revision+1,updated_at=excluded.updated_at`,id,note,seconds(),id,revision).run();
  if(!r.meta.changes)throw new UserError('备注已被更新，请刷新用户详情后重试。',409);
  return Response.json({ok:true});
 }
 if(path==='issues'&&req.method==='GET'){
  const page=integer(url.searchParams.get('page')||0,10000),filter=url.searchParams.get('filter')||'open';
  const filters={open:'handled=0',handled:'handled=1',all:'1=1',credentials:"category='credentials' AND handled=0",unknown:"category='unknown' AND handled=0",failed:"category='failed' AND handled=0",unverified:"category='unverified' AND handled=0",delayed:"category='delayed' AND handled=0"};
  if(!Object.hasOwn(filters,filter))throw new UserError('异常筛选无效。');
  const counts=await query(env,`SELECT COUNT(*) AS total,COALESCE(SUM(handled=0),0) AS open,COALESCE(SUM(category='credentials'),0) AS credentials,COALESCE(SUM(handled=1),0) AS handled FROM (${issueQuery})`).first();
  const {results}=await query(env,`SELECT * FROM (${issueQuery}) WHERE ${filters[filter]} ORDER BY updated_at DESC,id DESC LIMIT 21 OFFSET ?`,page*20).all();
  return Response.json({counts,page,has_more:results.length>20,issues:results.slice(0,20).map(r=>({...r,advice:advice[r.category]}))});
 }
 if(path==='issues/review'&&req.method==='POST'){
  const id=str(data.id,100,true),note=str(data.note,600,true),snapshot=str(data.stamp,200,true),revision=integer(data.revision);
  const r=await query(env,`INSERT INTO issue_reviews(run_id,stamp,note,revision,updated_at)
   SELECT r.id,?,?,1,? FROM runs r WHERE r.id=? AND ${runIssue} AND (${stamp})=? AND COALESCE((SELECT revision FROM issue_reviews WHERE run_id=r.id),0)=?
   ON CONFLICT(run_id) DO UPDATE SET stamp=excluded.stamp,note=excluded.note,revision=issue_reviews.revision+1,updated_at=excluded.updated_at`,snapshot,note,seconds(),id,snapshot,revision).run();
  if(!r.meta.changes)throw new UserError('任务结果或处理记录已变化，请刷新后再处理。',409);
  return Response.json({ok:true});
 }
 throw new UserError('管理接口不存在。',404);
}
