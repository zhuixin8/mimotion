export const SCHEDULE_UTC_HOURS=[0,2,4,6,8,14];
export function nextExecution(account,access,now=Date.now()) {
 if(!account)return {at:null,reason:'账号资料已删除'};
 if(access.suspended)return {at:null,reason:'账号已停用'};
 if(!access.active)return {at:null,reason:'请先激活或续期'};
 if(account.needs_login)return {at:null,reason:'凭据失效，请重新登录'};
 if(!account.enabled)return {at:null,reason:'自动计划已暂停'};
 const date=new Date(now),start=Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),date.getUTCDate());
 const next=[...SCHEDULE_UTC_HOURS.map(h=>start+h*3600000+35*60000),start+86400000+35*60000].find(t=>t>now);
 if(next/1000>=access.expires_at)return {at:null,reason:'下次执行前使用期将到期，请先续期'};
 return {at:next/1000,reason:'预计排队时间，实际开始可能稍有延迟'};
}
