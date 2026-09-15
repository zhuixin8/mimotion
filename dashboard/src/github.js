import sealedbox from 'tweetnacl-sealedbox-js';
import {fetchJSON, UserError, b64, unb64, utf8, aesCBC} from './security.js';
export async function github(path, token, method = 'GET', body) {
  const {response, data} = await fetchJSON('https://api.github.com' + path, {method,
    headers: {'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10', 'User-Agent': 'mimotion-dashboard', ...(token ? {'Authorization': 'Bearer ' + token} : {}), ...(body ? {'Content-Type': 'application/json'} : {})},
    ...(body ? {body: JSON.stringify(body)} : {})});
  if (!response.ok) {
    const errors = {401: 'GitHub 登录已过期，请重新登录。', 403: 'GitHub 授权不足或请求受限，请检查应用权限。', 404: '应用尚未授权访问 mimotion 仓库，请先安装并选择该仓库。', 409: '仓库正在更新，请稍后重试。', 422: 'GitHub 未接受请求，请检查仓库和工作流设置。'};
    throw new UserError(errors[response.status] || `GitHub 请求失败（HTTP ${response.status}）。`, response.status === 401 ? 401 : 502);
  }
  return data;
}
export function encryptSecret(value, publicKey) {
  return b64(sealedbox.seal(utf8(value), unb64(publicKey)));
}
export async function saveConfig(env, token, prepared) {
  const root = '/repos/' + env.GITHUB_REPO;
  const repo = await github(root, token);
  const flow = await github(root + '/actions/workflows/run.yml', token);
  const key = await github(root + '/actions/secrets/public-key', token);
  const completed = [];
  const values = {AES_KEY: prepared.aes_key, LOGIN_TOKENS: b64(await aesCBC(JSON.stringify(prepared.tokens), prepared.aes_key)), CONFIG: JSON.stringify(prepared.config)};
  try {
    for (const [name, value] of Object.entries(values)) {
      await github(root + '/actions/secrets/' + name, token, 'PUT', {encrypted_value: encryptSecret(value, key.key), key_id: key.key_id});
      completed.push(name);
    }
    if (flow.state !== 'active') await github(root + '/actions/workflows/run.yml/enable', token, 'PUT');
    await github(root + '/actions/workflows/run.yml/dispatches', token, 'POST', {ref: repo.default_branch});
    return {ok: true, message: '配置已保存，已请求运行。下方会显示 GitHub 的执行状态；步数是否同步仍需查看运行结果。', completed};
  } catch (e) {
    const base = e instanceof UserError ? e.message : '网络请求中断，本次请求结果可能尚未确认。';
    throw new UserError(base + (completed.length ? ' 已确认保存：' + completed.join('、') + '。请保留当前页面并重试，完成剩余步骤。' : ' 请重试。'), 502);
  }
}
