import template from './band-template.json';
import {fetchJSON, UserError, UpstreamError} from './security.js';
export async function refreshToken(tokens) {
  const params = new URLSearchParams({app_name:'com.xiaomi.hm.health', dn:'api-user.huami.com,api-mifit.huami.com,app-analytics.huami.com', login_token:tokens.login_token});
  const {response, data} = await fetchJSON('https://account-cn.huami.com/v1/client/app_tokens?' + params, {headers:{'user-agent':'MiFit/5.3.0 (iPhone; iOS 14.7.1; Scale/3.00)'}}, 'Zepp 凭据刷新接口');
  if (response.status === 429 || response.status >= 500) throw new UserError('Zepp 服务暂时不可用，请稍后重试。', 503);
  // Observed 0105 returns HTTP 200 without token_info. Recover through the
  // existing access grant once, before any step submission, and verify identity.
  if(response.ok && String(data.error_code)==='0105')return restoreClientGrant(tokens);
  if (response.status===401 || response.status===403 || data.result==='fail') throw new UserError('Zepp 登录凭据已失效，请重新登录。', 401);
  if (!response.ok || data.result !== 'ok' || !data.token_info?.app_token) throw new UpstreamError('Zepp 凭据接口响应格式发生变化，暂时无法验证。','response_format');
  tokens.app_token = data.token_info.app_token;
  tokens.app_token_time = String(Date.now());
}
async function restoreClientGrant(tokens){
  if(!tokens.access_token||!tokens.device_id)throw new UserError('Zepp 登录授权需要更新，请退出本站后重新登录。',401);
  // Older stored credentials lacked login_type. The email grant may recover
  // those accounts; unsuccessful legacy phone grants require an explicit login.
  const type=tokens.login_type||'email',phone=type==='huami_phone';
  if(!['email','huami_phone'].includes(type))throw new UserError('Zepp 登录授权需要更新，请退出本站后重新登录。',401);
  const form={app_name:'com.xiaomi.hm.health',app_version:'6.14.0',code:tokens.access_token,country_code:'CN',device_id:tokens.device_id,device_model:phone?'phone':'android_phone',grant_type:'access_token',third_name:type,allow_registration:'false'};
  if(!phone)Object.assign(form,{lang:'zh_CN',os_version:'1.5.0',source:'com.xiaomi.hm.health:6.14.0:50818',dn:'account.zepp.com,api-user.zepp.com,api-mifit.zepp.com,api-watch.zepp.com,app-analytics.zepp.com,api-analytics.huami.com,auth.zepp.com'});
  const {response,data}=await fetchJSON('https://account.huami.com/v2/client/login',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded; charset=UTF-8','user-agent':'MiFit6.14.0 (M2007J1SC; Android 12; Density/2.75)',app_name:'com.xiaomi.hm.health',appname:'com.xiaomi.hm.health',appplatform:'android_phone',cv:'50818_6.14.0',v:'2.0','x-request-id':crypto.randomUUID()},body:new URLSearchParams(form)},'Zepp 授权恢复接口');
  if(response.status===429||response.status>=500)throw new UserError('Zepp 授权恢复暂时不可用，请稍后重试。',503);
  if(response.status===401||response.status===403||data.result==='fail'||String(data.error_code)==='0105')throw new UserError('Zepp 登录授权已失效，请退出本站后重新登录。',401);
  const info=data.token_info;
  if(!response.ok||data.result!=='ok'||!info?.login_token||!info?.app_token||!info?.user_id)throw new UpstreamError('Zepp 授权恢复未返回完整凭据，请稍后重试或重新登录。','response_format');
  if(String(info.user_id)!==String(tokens.user_id))throw new UserError('Zepp 授权账号不一致，已停止执行，请重新登录。',401);
  Object.assign(tokens,{login_token:info.login_token,app_token:info.app_token,login_type:type,login_token_time:String(Date.now()),app_token_time:String(Date.now())});
}
export function bandPayload(tokens, step, day) {
  const device = tokens.bound_device_id || 'DA932FFFFE8816E7';
  const data = JSON.parse(JSON.stringify(template).replaceAll('DA932FFFFE8816E7', device));
  data[0].date = day;
  const summary = JSON.parse(data[0].summary); summary.stp.ttl = step;
  data[0].summary = JSON.stringify(summary);
  return new URLSearchParams({userid:String(tokens.user_id),last_sync_data_time:'1597306380',device_type:'0',last_deviceid:device,data_json:JSON.stringify(data)});
}
export async function submitSteps(tokens, step, day) {
  const {response, data} = await fetchJSON('https://api-mifit-cn.huami.com/v1/data/band_data.json?&t=' + Date.now() + '&r=' + crypto.randomUUID(), {
    method:'POST',headers:{apptoken:tokens.app_token,'content-type':'application/x-www-form-urlencoded'},body:bandPayload(tokens, step, day)
  }, 'Zepp 步数提交接口');
  if (response.status >= 500) throw new UserError('Zepp 提交结果暂时无法确认。', 503);
  if (!response.ok || data.message !== 'success') throw new UserError('Zepp 未接受本次步数提交，请先在官方 App 检查账号状态。', 422);
}
