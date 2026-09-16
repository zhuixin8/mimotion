import {b64,unb64,UserError} from './security.js';
import {parseDaySteps,parseMinuteSteps} from './verification.js';

// A bounded diagnostic append, not a daily target generator or Bluetooth emulator.
export function planMinuteAppend(row,device,day,now=Date.now()){
  const local=new Date(now+28800000),elapsed=local.getUTCHours()*60+local.getUTCMinutes();
  if(local.toISOString().slice(0,10)!==day||(row.date_time||row.date)!==day)throw new UserError('日期已变化，请重新读取今天的数据。');
  if(!/^[A-F0-9]{12,16}$/i.test(device)||String(row.device_id).toUpperCase()!==device.toUpperCase())throw new UserError('分钟记录与绑定设备不匹配，未提交。');
  if(row.mergedRawData!=null&&row.mergedRawData!==row.data)throw new UserError('存在不同的合并明细，无法安全追加。');
  const beforeDetail=parseMinuteSteps(row.data),beforeSummary=parseDaySteps({data:[row]},day),source=Number(row.source);
  if(beforeDetail===null||beforeSummary===null||row.source==null||!Number.isSafeInteger(source)||source<0||source>1000)throw new UserError('缺少可核实的原始分钟记录或来源，未提交。');
  const original=unb64(row.data),stride=original.length/1440;
  const blank=i=>original[i*stride]===126&&original.slice(i*stride+1,(i+1)*stride).every(n=>n===0);
  const slots=Array.from({length:elapsed},(_,i)=>i).filter(blank).slice(-2);
  if(slots.length!==2)throw new UserError('今天已过去的空白分钟不足 2 个，请稍后重新读取。');
  const raw=original.slice();
  for(const minute of slots){raw[minute*stride]=1;raw[minute*stride+1]=50;raw[minute*stride+2]=120;}
  const expectedDetail=beforeDetail+240,expectedSummary=Math.max(beforeSummary,expectedDetail);
  if(expectedSummary>50000)throw new UserError('本次诊断会超过 50,000 步，未提交。');
  if(parseMinuteSteps(b64(raw))!==expectedDetail)throw new UserError('分钟数据校验未通过。');
  let summary=row.summary;
  if(typeof summary==='string'){try{summary=JSON.parse(summary);}catch{summary=JSON.parse(new TextDecoder().decode(unb64(summary)));}}
  summary=structuredClone(summary);summary.stp.ttl=expectedSummary;
  return {beforeDetail,beforeSummary,expectedDetail,expectedSummary,minutes:slots,stride,
    row:{date:day,data:[{start:0,stop:1439,value:b64(raw),tz:32,did:device,src:source}],summary:JSON.stringify(summary),source,type:0}};
}
