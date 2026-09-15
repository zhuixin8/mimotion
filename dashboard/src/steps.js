import template from './band-template.json';
import {fetchJSON, UserError} from './security.js';
export async function refreshToken(tokens) {
  const params = new URLSearchParams({app_name:'com.xiaomi.hm.health', dn:'api-user.huami.com,api-mifit.huami.com,app-analytics.huami.com', login_token:tokens.login_token});
  const {response, data} = await fetchJSON('https://account-cn.huami.com/v1/client/app_tokens?' + params, {headers:{'user-agent':'MiFit/5.3.0 (iPhone; iOS 14.7.1; Scale/3.00)'}}, 'Zepp 凭据刷新接口');
  if (response.status === 429 || response.status >= 500) throw new UserError('Zepp 服务暂时不可用，请稍后重试。', 503);
  if (!response.ok || data.result !== 'ok' || !data.token_info?.app_token) throw new UserError('Zepp 登录凭据已失效，请重新登录。', 401);
  tokens.app_token = data.token_info.app_token;
  tokens.app_token_time = String(Date.now());
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
