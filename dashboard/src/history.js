import {query, beijing} from './jobs.js';
import {UserError} from './security.js';
import {membership} from './licensing.js';

export async function history(env, accountId, url) {
  const filter = url.searchParams.get('filter') || 'all';
  const page = Number(url.searchParams.get('page') || 0);
  const date = url.searchParams.get('day') || '';
  const filters = {
    all:'1=1', active:"status IN ('pending','queued','running') OR verification='checking'",
    attention:"status IN ('failed','unknown','skipped') OR verification IN ('below_target','unavailable')",
    matched:"verification='matched'", check:"kind IN ('check','verify')"
  };
  if (!Object.hasOwn(filters,filter) || !Number.isInteger(page) || page<0 || page>10000 || (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))))) throw new UserError('记录筛选条件无效。');
  const args = [accountId]; if(date)args.push(date);args.push(page*30);
  const {results} = await query(env, `SELECT id,kind,day,step,status,message,created_at,started_at,finished_at,before_step,observed_step,verification,checked_at,parent_id
    FROM runs WHERE account_id=? AND (${filters[filter]}) ${date?'AND day=?':''}
    ORDER BY created_at DESC,id DESC LIMIT 31 OFFSET ?`, ...args).all();
  const stats = await query(env, `SELECT COUNT(*) AS total,
    COALESCE(SUM(status='success'),0) AS accepted,
    COALESCE(SUM(verification='matched'),0) AS matched,
    COALESCE(SUM(status IN ('pending','queued','running') OR verification='checking'),0) AS active
    FROM runs WHERE account_id=? AND day=? AND kind IN ('manual','schedule')`, accountId, beijing().slice(0,10)).first();
  const check = await query(env, "SELECT status,message,observed_step,verification,day,created_at,finished_at FROM runs WHERE account_id=? AND kind='check' ORDER BY created_at DESC,id DESC LIMIT 1", accountId).first();
  return {runs:results.slice(0,30),page,has_more:results.length>30,stats,check,membership:await membership(env,accountId)};
}
