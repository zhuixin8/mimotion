import {query,beijing} from './jobs.js';
import {UserError} from './security.js';

function validDay(value){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;
  const time=Date.parse(value+'T00:00:00Z');
  return Number.isFinite(time)&&new Date(time).toISOString().slice(0,10)===value;
}
// Daily steps are cumulative targets, never the sum of six submissions.
// Only manual/schedule success means upstream acceptance. Checks do not submit.
export async function dailyHistory(env,accountId,url){
  const p=url.searchParams,detail=p.get('detail'),from=p.get('from')||'',to=p.get('to')||'',page=Number(p.get('page')||0);
  if((detail!==null&&!validDay(detail))||(from&&!validDay(from))||(to&&!validDay(to))||(from&&to&&from>to)||!Number.isInteger(page)||page<0||page>10000)throw new UserError('请选择有效的日期范围。');
  if(detail!==null){
    const {results}=await query(env,`SELECT id,kind,step,status,message,created_at,finished_at,summary_step,detail_step,evidence_state,checked_at
      FROM runs WHERE account_id=? AND day=? AND kind IN ('manual','schedule')
      ORDER BY created_at DESC,rowid DESC LIMIT 101`,accountId,detail).all();
    return {day:detail,attempts:results.slice(0,100),has_more:results.length>100};
  }
  const args=[accountId];if(from)args.push(from);if(to)args.push(to);args.push(page*14);
  const {results}=await query(env,`WITH eligible AS (
    SELECT rowid AS seq,* FROM runs WHERE account_id=? AND kind IN ('manual','schedule') ${from?'AND day>=?':''} ${to?'AND day<=?':''}
  ), ranked AS (
    SELECT *,ROW_NUMBER() OVER(PARTITION BY day ORDER BY CASE WHEN status='success' THEN 0 ELSE 1 END,COALESCE(finished_at,created_at) DESC,seq DESC) AS accepted_rank,
      ROW_NUMBER() OVER(PARTITION BY day ORDER BY created_at DESC,seq DESC) AS latest_rank
    FROM eligible
  ) SELECT day,COUNT(*) AS attempts,SUM(status='success') AS accepted_count,
    SUM(status IN ('pending','queued','running')) AS active_count,SUM(status='unknown') AS unknown_count,SUM(status='failed') AS failed_count,
    MAX(CASE WHEN latest_rank=1 THEN status END) AS latest_status,
    MAX(CASE WHEN accepted_rank=1 AND status='success' THEN step END) AS final_step,
    MAX(CASE WHEN accepted_rank=1 AND status='success' THEN COALESCE(finished_at,created_at) END) AS final_at,
    MAX(CASE WHEN accepted_rank=1 AND status='success' THEN summary_step END) AS summary_step,
    MAX(CASE WHEN accepted_rank=1 AND status='success' THEN detail_step END) AS detail_step,
    MAX(CASE WHEN accepted_rank=1 AND status='success' THEN evidence_state END) AS evidence_state
    FROM ranked GROUP BY day ORDER BY day DESC LIMIT 15 OFFSET ?`,...args).all();
  return {days:results.slice(0,14),page,has_more:results.length>14,today:beijing().slice(0,10),retention_days:30};
}
