import {fetchJSON, UserError, UpstreamError, unb64} from './security.js';

// Protocol references and response shapes are documented in README.md.
export function parseDaySteps(data, day) {
  if (!Array.isArray(data.data)) return null;
  const values = [];
  for (const row of data.data) {
    if ((row.date_time || row.date) !== day) continue;
    try {
      let summary = row.summary;
      if (typeof summary === 'string') {
        if (summary.length > 131072) continue;
        try { summary = JSON.parse(summary); }
        catch { summary = JSON.parse(new TextDecoder().decode(unb64(summary))); }
      }
      const value = summary?.stp?.ttl;
      if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 1000000) values.push(value);
    } catch { /* Unknown formats are unavailable, never zero or a success. */ }
  }
  // Conflicting summaries may belong to different devices. Do not guess totals.
  return values.length && values.every(n=>n===values[0]) ? values[0] : null;
}
export async function readDaySteps(tokens, day) {
  const params = new URLSearchParams({userid:String(tokens.user_id),from_date:day,to_date:day,query_type:'detail',device_type:'0',byteLength:'8'});
  const {response,data} = await fetchJSON('https://api-mifit-cn.huami.com/v1/data/band_data.json?' + params, {headers:{apptoken:tokens.app_token,'user-agent':'MiFit6.14.0 (M2007J1SC; Android 12; Density/2.75)'}}, 'Zepp 步数查询接口');
  if (!response.ok || data.message !== 'success') throw new UserError('暂时无法读取 Zepp 云端步数，请稍后重新核对。', 502);
  return parseDaySteps(data,day);
}
export async function isAppTokenValid(tokens) {
  const params = new URLSearchParams({userid:String(tokens.user_id),r:crypto.randomUUID(),appid:'428135909242707968',channel:'Normal',country:'CN',cv:'50818_6.14.0',device:'android_31',device_type:'android_phone',lang:'zh_CN',timezone:'Asia/Shanghai',v:'2.0'});
  const {response,data} = await fetchJSON('https://api-mifit-cn3.zepp.com/huami.health.getUserInfo.json?' + params, {headers:{apptoken:tokens.app_token,appname:'com.xiaomi.hm.health',appplatform:'android_phone','user-agent':'MiFit6.14.0 (M2007J1SC; Android 12; Density/2.75)'}}, 'Zepp 账号连接接口');
  if(response.status===401||response.status===403)return false;
  if(!response.ok||data.message!=='success')throw new UpstreamError('暂时无法确认 Zepp 凭据状态，未尝试重新登录。','response_format');
  return true;
}
export async function checkConnection(tokens) {
  if(!await isAppTokenValid(tokens))throw new UserError('账号连接测试未通过，请稍后重试或重新登录。',502);
}
export function outcome(observed, target) {
  return observed === null ? 'unavailable' : observed >= target ? 'matched' : 'below_target';
}
export const verificationText = value => ({matched:'读回的 Zepp 云端步数已达到目标',below_target:'读回步数暂未达到目标，可稍后重新核对',unavailable:'暂时无法读回当天步数，尚未核实效果'}[value] || '尚未核对');
