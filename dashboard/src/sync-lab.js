import {query,seconds,limit} from './jobs.js';
import {open,seal,fetchJSON,UserError} from './security.js';
import {requireMembership} from './licensing.js';
import {readDayData,parseDayEvidence} from './verification.js';
import {refreshToken} from './steps.js';
import {planMinuteAppend} from './minute-plan.js';

const today=()=>new Date(Date.now()+28800000).toISOString().slice(0,10);
const headers=t=>({apptoken:t.app_token,app_name:'com.xiaomi.hm.health',appname:'com.xiaomi.hm.health',appplatform:'android_phone','user-agent':'MiFit6.14.0 (2211133C; Android 15; Density/2.75)'});
const common={device:'android_35',device_type:'android_phone',enableMultiDevice:'true',v:'2.0',lang:'zh_CN',channel:'Normal',country:'CN',timezone:'Asia/Shanghai',cv:'50813_6.14.0'};
export async function labDevices(tokens){
  const stamp=String(seconds()),params=new URLSearchParams({...common,userid:String(tokens.user_id),t:stamp,callid:stamp});
  const {response,data}=await fetchJSON('https://api-mifit-cn.huami.com/v1/device/lists.json?'+params,{headers:headers(tokens)},'Zepp 设备查询');
  if(!response.ok||Number(data?.code)!==1||!Array.isArray(data.data)||data.data.some(d=>!d||String(d.uid)!==String(tokens.user_id)||!Number.isInteger(Number(d.device_type))||typeof d.deviceid!=='string'))throw new UserError('设备列表不可确认，未进行绑定或提交。',502);
  return data.data;
}
const deviceView=d=>({id_suffix:String(d.deviceid).slice(-4),product_id:d.productId??null,active:d.activeStatus==null?null:Number(d.activeStatus)===1,binding_status:d.binding_status??null});
function ownRow(data,tokens,day){
  const rows=Array.isArray(data?.data)?data.data.filter(r=>r&&(r.date_time||r.date)===day):[];
  if(rows.length!==1||String(rows[0].uid)!==String(tokens.user_id))throw new UserError('未找到唯一的本人当天分钟记录，未提交。');
  return rows[0];
}
export async function labHistory(env,id){
  const {results}=await query(env,'SELECT id,kind,day,status,message,evidence,created_at,finished_at FROM sync_lab_operations WHERE account_id=? ORDER BY created_at DESC,id DESC LIMIT 20',id).all();
  const {results:claims}=await query(env,'SELECT slot FROM sync_lab_claims WHERE account_id=? AND slot IN (?,?)',id,'bind','append:'+today()).all();
  return {records:results.map(r=>({...r,evidence:r.evidence?JSON.parse(r.evidence):null})),bind_claimed:claims.some(r=>r.slot==='bind'),append_claimed:claims.some(r=>r.slot.startsWith('append:'))};
}
export async function labAction(env,s,kind,data){
  if(!['inspect','bind','append'].includes(kind))throw new UserError('诊断操作不存在。',404);
  const mutation=kind!=='inspect';
  if(mutation&&data.confirm!==true)throw new UserError('请先确认实验操作的影响。');
  await requireMembership(env,s.id);
  await limit(env,'sync-lab:'+s.id,3,60);
  const id=crypto.randomUUID(),day=today(),now=seconds();
  const lock=await query(env,`UPDATE accounts SET lease_id=?,lease_until=? WHERE id=? AND session_version=? AND lease_until<? AND NOT EXISTS(SELECT 1 FROM runs WHERE account_id=? AND status IN ('pending','queued','running'))`,id,now+300,s.id,s.version,now,s.id).run();
  if(!lock.meta.changes)throw new UserError('账号有任务正在排队或执行，请稍后再试。',409);
  let claimed=false,recorded=false;
  async function fence(){
    await requireMembership(env,s.id);
    if(today()!==day||!await query(env,'SELECT id FROM accounts WHERE id=? AND session_version=? AND lease_id=? AND lease_until>?',s.id,s.version,id,seconds()+30).first())throw new UserError('日期、登录状态或执行锁已变化，未继续提交。',409);
  }
  async function finish(status,message,evidence=null){
    await query(env,'UPDATE sync_lab_operations SET status=?,message=?,evidence=?,finished_at=? WHERE id=? AND account_id=?',status,message,evidence?JSON.stringify(evidence):null,seconds(),id,s.id).run();
    return {ok:true,id,status,message,evidence};
  }
  async function claim(slot){
    const r=await query(env,'INSERT INTO sync_lab_claims(account_id,slot,operation_id,created_at) VALUES(?,?,?,?) ON CONFLICT(account_id,slot) DO NOTHING',s.id,slot,id,seconds()).run();
    if(!r.meta.changes)throw new UserError('该操作已有提交记录；请读取核对，不会重复提交。',409);
    claimed=true;
    await query(env,"UPDATE sync_lab_operations SET status='submitted',message='已记录提交意图；如结果未返回，请只读核对，勿重复提交。' WHERE id=?",id).run();
  }
  try{
    await query(env,"INSERT INTO sync_lab_operations(id,account_id,kind,day,status,created_at) VALUES(?,?,?,?,'checking',?)",id,s.id,kind,day,now).run();recorded=true;
    const a=await query(env,'SELECT credentials FROM accounts WHERE id=? AND lease_id=?',s.id,id).first();
    const tokens=await open(a.credentials,env.MASTER_SECRET,'zepp:'+s.id);
    try{await refreshToken(tokens);}catch(e){
      if(e instanceof UserError&&e.status===401)await query(env,'UPDATE accounts SET needs_login=1,enabled=0 WHERE id=? AND lease_id=? AND session_version=?',s.id,id,s.version).run();
      throw e;
    }
    await fence();
    await query(env,'UPDATE accounts SET credentials=?,needs_login=0 WHERE id=? AND lease_id=? AND session_version=?',await seal(tokens,env.MASTER_SECRET,'zepp:'+s.id),s.id,id,s.version).run();
    const devices=await labDevices(tokens);
    if(kind==='bind'){
      // Refuse ANY existing device, including inactive or unrecognized hardware.
      if(devices.length)throw new UserError('账号已有设备，不再创建虚拟设备。可先查看设备状态。',409);
      const hex=b=>Array.from(b,n=>n.toString(16).padStart(2,'0')).join('').toUpperCase();
      const deviceid=hex(crypto.getRandomValues(new Uint8Array(8))),macBytes=crypto.getRandomValues(new Uint8Array(6));macBytes[0]=(macBytes[0]|2)&254;
      const params=new URLSearchParams({...common,app_time:String(seconds()),code:'0',activeStatus:'0',bind_timezone:'32',device_type:'0',crcedUserId:'0',userid:String(tokens.user_id),device:'android_29',deviceid,mac:Array.from(macBytes,n=>hex([n])).join(':'),productVersion:'256',brandType:'-1',productId:'61',device_source:'58',brand:'XiaoMi',fw_version:'V1.0.0.04',hardwareVersion:'V0.44.131.18',soft_version:'6.13.1',sys_model:'Xiaomi 10 Pro',sys_version:'Android_35'});
      await fence();await claim('bind');await fence();
      const {response,data:result}=await fetchJSON('https://api-mifit-cn.huami.com/v1/device/binds.json',{method:'POST',headers:{...headers(tokens),'content-type':'application/x-www-form-urlencoded'},body:params},'虚拟设备绑定');
      const after=await labDevices(tokens),found=after.some(d=>String(d.deviceid).toUpperCase()===deviceid);
      if(found){
        await fence();
        const credentials=await seal({...tokens,bound_device_id:deviceid,bound_device_source:'virtual-lab'},env.MASTER_SECRET,'zepp:'+s.id);
        await query(env,'UPDATE accounts SET credentials=? WHERE id=? AND lease_id=? AND session_version=?',credentials,s.id,id,s.version).run();
      }
      return await finish(found?'verified':'unconfirmed',found?'设备列表已读回新设备。虚拟设备未完成蓝牙启用，不代表微信可同步。':'绑定结果未确认，请只读查看设备，勿重复绑定。',{accepted:response.ok&&Number(result?.code)===1,devices:after.map(deviceView)});
    }
    let baseline=await readDayData(tokens,day);
    if(kind==='inspect'){
      // Do not expose a merged/foreign row as verified account evidence.
      if(Array.isArray(baseline?.data)&&baseline.data.some(r=>String(r?.uid)!==String(tokens.user_id)))throw new UserError('读回记录的账号归属不明确。',502);
      return await finish('read','只读核对完成。第三方同步状态需在微信等应用中确认。',{devices:devices.map(deviceView),...parseDayEvidence(baseline,day),checked_at:seconds()});
    }
    if(devices.length!==1||Number(devices[0].device_type)!==0)throw new UserError('需要唯一且可确认的手环设备，未提交。');
    const device=devices[0].deviceid.toUpperCase();
    let row=ownRow(baseline,tokens,day),plan=planMinuteAppend(row,device,day);
    // Refresh immediately before the POST; never overwrite a changed baseline.
    const fresh=ownRow(await readDayData(tokens,day),tokens,day);
    if(JSON.stringify(fresh)!==JSON.stringify(row))throw new UserError('云端记录刚刚发生变化，请重新读取后再试。',409);
    await fence();
    plan=planMinuteAppend(fresh,device,day);
    const body=new URLSearchParams({userid:String(tokens.user_id),last_sync_data_time:String(seconds()),device_type:'0',last_deviceid:device,last_source:String(plan.row.source),data_json:JSON.stringify([plan.row])});
    if(typeof row.uuid==='string'&&/^[a-f\d-]{36}$/i.test(row.uuid))body.set('uuid',row.uuid);
    if(plan.stride===8)body.set('byteLength','8');
    const comparison={before_summary:plan.beforeSummary,before_detail:plan.beforeDetail,expected_summary:plan.expectedSummary,expected_detail:plan.expectedDetail,minutes:plan.minutes,device_suffix:device.slice(-4)};
    await query(env,'UPDATE sync_lab_operations SET evidence=? WHERE id=?',JSON.stringify(comparison),id).run();
    await claim('append:'+day);await fence();
    const {response,data:result}=await fetchJSON('https://api-mifit-cn.huami.com/v1/data/band_data.json',{method:'POST',headers:{...headers(tokens),'content-type':'application/x-www-form-urlencoded'},body},'分钟明细实验');
    const after=ownRow(await readDayData(tokens,day),tokens,day),evidence=parseDayEvidence({data:[after]},day);
    const matched=String(after.device_id).toUpperCase()===device&&after.data===plan.row.data[0].value&&evidence.detail===plan.expectedDetail&&evidence.summary===plan.expectedSummary;
    return await finish(matched?'verified':'unconfirmed',matched?'追加 240 步的分钟数据已原样读回。是否同步微信仍待确认。':'已发送一次，读回尚未确认；今天不再追加，请只读核对。',{...comparison,...evidence,accepted:response.ok&&result.message==='success',checked_at:seconds()});
  }catch(e){
    const message=claimed?'已记录一次提交意图，结果未确认。不会自动重试，请只读核对。':e instanceof UserError?e.message:'诊断暂时不可用，未发出修改请求。';
    if(recorded)await query(env,'UPDATE sync_lab_operations SET status=?,message=?,finished_at=? WHERE id=? AND account_id=?',claimed?'unconfirmed':'blocked',message,seconds(),id,s.id).run();
    throw new UserError(message,claimed?502:e instanceof UserError?e.status:503);
  }finally{
    await query(env,'UPDATE accounts SET lease_id=NULL,lease_until=0 WHERE id=? AND lease_id=?',s.id,id).run();
  }
}
