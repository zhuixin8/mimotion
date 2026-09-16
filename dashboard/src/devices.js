import {fetchJSON,UpstreamError} from './security.js';

// Protocol reference: netcccyun/toolbox, XiaomiSport.php at 70c00a945d68.
// Verified against the owner's account: lists.json is the read endpoint;
// binds.json is a mutation endpoint. No binding requests are issued here.
export function selectBoundDevice(data,userId){
  if(Number(data?.code)!==1||!Array.isArray(data.data))throw new UpstreamError('暂时无法确认 Zepp 设备列表。','response_format');
  const devices=data.data.filter(d=>d&&String(d.uid)===String(userId)&&Number(d.device_type)===0&&typeof d.deviceid==='string'&&/^[a-fA-F0-9]{12,16}$/.test(d.deviceid));
  const ids=[...new Set(devices.map(d=>d.deviceid.toUpperCase()))];
  // Multiple devices need an explicit selection; never silently select another.
  return ids.length===1?ids[0]:null;
}
export async function readBoundDevice(tokens){
  const stamp=String(Math.floor(Date.now()/1000));
  const query=new URLSearchParams({userid:String(tokens.user_id),t:stamp,callid:stamp,device:'android_35',device_type:'android_phone',enableMultiDevice:'true',v:'2.0',lang:'zh_CN',channel:'Normal',country:'CN',timezone:'Asia/Shanghai',cv:'50813_6.14.0'});
  const {response,data}=await fetchJSON('https://api-mifit-cn.huami.com/v1/device/lists.json?'+query,{headers:{apptoken:tokens.app_token,app_name:'com.xiaomi.hm.health',appname:'com.xiaomi.hm.health',appplatform:'android_phone','user-agent':'MiFit6.14.0 (2211133C; Android 15; Density/2.75)'}},'Zepp 设备查询接口');
  if(!response.ok)throw new UpstreamError('暂时无法读取 Zepp 设备列表。','device_unavailable');
  return selectBoundDevice(data,tokens.user_id);
}
