// Presentation only: never infers a successful submission from an animation.
export function avatarState(account, runtime, receivedAt, now=Date.now()) {
  if (!account) return {motion:'idle',animate:false,title:'尚未登录',detail:'登录后查看自己的计划。'};
  const access=account.membership;
  if (access?.suspended) return {motion:'idle',animate:false,title:'账号已停用',detail:'请联系管理员了解账号状态。'};
  if (!access?.active || access.expires_at*1000<=now) return {motion:'idle',animate:false,title:'等待激活或续期',detail:'使用期有效后，才能执行步数计划。'};
  if (account.needs_login) return {motion:'idle',animate:false,title:'等待恢复连接',detail:'请先完成页面上的 Zepp 账号验证。'};
  if (!runtime || !receivedAt || now-receivedAt>90000) return {motion:'idle',animate:false,title:'等待状态更新',detail:'请以最新执行记录为准。'};
  const task=runtime.latest;
  if (task?.status==='running') return {motion:'run',animate:true,title:'任务处理中',detail:'正在处理最近一次提交，结果请查看每日记录。'};
  if (!account.enabled) return {motion:'idle',animate:false,title:'计划已暂停',detail:'开启自动执行并保存后，将按时间表运行。'};
  if (['queued','pending'].includes(task?.status)) return {motion:'idle',animate:true,title:'任务等待执行',detail:'任务已排队，请等待处理结果。'};
  return {motion:'idle',animate:true,title:'自动计划已开启',detail:'按已保存的时间表执行，关闭网页也会继续。'};
}
