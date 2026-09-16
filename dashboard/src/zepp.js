import {aesCBC, random, fetchJSON, UserError} from './security.js';
export function validate(data) {
  let account = typeof data.account === 'string' ? data.account.trim() : '';
  if (account.length > 254) throw new UserError('账号长度无效。');
  if (/^(\+86)?1[3-9]\d{9}$/.test(account)) account = account.startsWith('+86') ? account : '+86' + account;
  else if (!/^[^\s@#]+@[^\s@#]+\.[^\s@#]+$/.test(account)) throw new UserError('请输入 Zepp Life 邮箱或中国大陆手机号。');
  const password = data.password;
  if (typeof password !== 'string' || password.length < 1 || password.length > 256) throw new UserError('请输入有效密码。');
  const lo = Number(data.min_step), hi = Number(data.max_step);
  if (![data.min_step, data.max_step].every(v => ['string', 'number'].includes(typeof v) && String(v).trim() !== '')) throw new UserError('请输入步数范围。');
  if (data.min_step === '' || data.max_step === '' || !Number.isInteger(lo) || !Number.isInteger(hi) || lo < 0 || lo > hi || hi > 100000) throw new UserError('步数应为 0–100000 的整数，且最小值不大于最大值。');
  return {account, password, lo, hi};
}
export async function loginZepp(data) {
  const {account, password, lo, hi} = validate(data);
  const headers = {'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'user-agent': 'MiFit6.14.0 (M2007J1SC; Android 12; Density/2.75)',
    app_name: 'com.xiaomi.hm.health', appname: 'com.xiaomi.hm.health', appplatform: 'android_phone', 'x-hm-ekv': '1', 'hm-privacy-ceip': 'false'};
  const query = new URLSearchParams({emailOrPhone: account, password, state: 'REDIRECTION', client_id: 'HuaMi', country_code: 'CN', token: 'access', redirect_uri: 'https://s3-us-west-2.amazonaws.com/hm-registration/successsignin.html'});
  const response = await fetch('https://api-user.zepp.com/v2/registrations/tokens', {method: 'POST', headers, body: await aesCBC(query.toString(), 'xeNtBVqzDc6tuNTh', 'MAAAYAAAAAAAAABg'), redirect: 'manual', signal: AbortSignal.timeout(20000)});
  await response.body?.cancel();
  if (response.status === 429) throw new UserError('Zepp 请求过于频繁，请稍后再试。', 429);
  if (response.status !== 303) throw new UserError(`Zepp 登录请求未通过（HTTP ${response.status}）。请先在官方 App 确认账号可用。`, 422);
  const location = new URL(response.headers.get('Location') || '/', 'https://api-user.zepp.com');
  const access = location.searchParams.get('access');
  if (!access) throw new UserError(location.searchParams.get('error') === '401' ? 'Zepp 返回 401：账号或密码验证未通过。请先用相同信息登录 Zepp Life；小米账号和短信登录不能代替 Zepp 密码登录。' : 'Zepp 未返回登录凭据，请先在官方 App 完成账号验证。', 422);
  const device = crypto.randomUUID(); const phone = account.startsWith('+86');
  const grant = {app_name: 'com.xiaomi.hm.health', app_version: '6.14.0', code: access, country_code: 'CN', device_id: device, device_model: phone ? 'phone' : 'android_phone', grant_type: 'access_token', third_name: phone ? 'huami_phone' : 'email'};
  if (!phone) Object.assign(grant, {'allow_registration=': 'false', lang: 'zh_CN', os_version: '1.5.0', source: 'com.xiaomi.hm.health:6.14.0:50818', dn: 'account.zepp.com,api-user.zepp.com,api-mifit.zepp.com,api-watch.zepp.com,app-analytics.zepp.com,api-analytics.huami.com,auth.zepp.com'});
  // x-hm-ekv is specific to the encrypted registration request above. Forwarding
  // it here makes this form-encoded endpoint return encrypted binary, not JSON.
  const grantHeaders = {
    'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'user-agent': headers['user-agent'], 'accept-language': 'zh-CN',
    app_name: 'com.xiaomi.hm.health', appname: 'com.xiaomi.hm.health',
    appplatform: 'android_phone', 'x-request-id': crypto.randomUUID(),
    cv: '50818_6.14.0', v: '2.0',
  };
  const result = await fetchJSON('https://account.huami.com/v2/client/login', {method: 'POST', headers: grantHeaders, body: new URLSearchParams(grant)}, 'Zepp 客户端授权接口');
  const info = result.data.token_info;
  if (!result.response.ok || result.data.result !== 'ok' || !info?.login_token || !info?.app_token || !info?.user_id) throw new UserError('Zepp 客户端授权失败，未获得完整登录凭据。', 422);
  const stamp = String(Date.now());
  const tokens = {access_token: access, login_type: phone ? 'huami_phone' : 'email', login_token: info.login_token, app_token: info.app_token, user_id: info.user_id, device_id: device, access_token_time: stamp, login_token_time: stamp, app_token_time: stamp};
  try {
    const deviceResult = await fetchJSON('https://api-mifit-cn.huami.com/v1/device/binds.json?userid=' + encodeURIComponent(info.user_id), {headers: {apptoken: info.app_token, 'user-agent': headers['user-agent']}});
    const bound = deviceResult.data.items?.find(item => item.deviceType === 0 && (item.deviceId || item.mac));
    if (bound) tokens.bound_device_id = String(bound.deviceId || bound.mac).replaceAll(':', '').toUpperCase();
  } catch { /* Device lookup is optional; never expose its upstream response. */ }
  const key = random(12);
  return {config: {USER: account, PWD: password, MIN_STEP: String(lo), MAX_STEP: String(hi)}, aes_key: key,
    tokens: {[account]: tokens}, summary: {account: account.slice(0, 3) + '****' + account.slice(-4), min_step: lo, max_step: hi, device_found: !!tokens.bound_device_id}};
}
