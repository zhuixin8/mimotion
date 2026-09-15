# MiMotion 多用户网页版

直接用 Zepp Life 邮箱/手机号及密码登录，首次成功自动创建本站账号，不需要 GitHub 账号或邀请码。网站不会创建 Zepp 官方账号。

## 使用

1. 登录自己的 Zepp Life，设置每日步数范围。
2. 勾选自动执行并保存。首次登录默认暂停。
3. 点击立即执行，可在网页查看结果。关闭网页或退出登录不影响已开启的计划。
4. 凭据失效会暂停计划，重新登录后需要再次开启。
5. 删除本站账号会删除在线数据库中的凭据、设置和记录，停止后续任务；不删除 Zepp 官方账号。

每人只能管理自己的数据。多人可同时使用不同账号；一个浏览器会话管理一个账号，切换账号请先退出。相同 Zepp 用户 ID 只建立一份计划，以最后一次登录的会话为准。

## 架构与限制

- Worker 提供网站/API；以 Zepp 成功返回的 user_id 经 HMAC 得到内部账号标识，客户端不能指定操作目标账号。
- D1 保存账号及记录；AES-GCM 按账号绑定加密。密码只用于当次验证，不写数据库、日志或 GitHub。
- HttpOnly/Secure/SameSite=Strict 会话有效期 24 小时，同源 POST + CSRF 校验；重新登录或退出会撤销旧会话。
- Queues 并发上限 3，同一账号用数据库租约串行执行。D1 保留待投递任务，定时补发未确认投递的任务。
- 每 5 分钟维护队列，在北京时间 08:35、10:35、12:35、14:35、16:35、22:35 生成自动任务。实际开始可能延迟。
- 日内逐步增加，22 点后达到设置范围；不降低本站当日已提交或结果待确认的步数。无法保证避免其他设备或工具写入产生的冲突。
- 提交超时或中断标记为结果待确认，不自动重发可能已成功的请求；跨北京时间日期的任务不再提交。
- 凭据刷新不依赖保存密码；凭据失效需重新登录，不能承诺永久免登录。
- 当前容量 200 个账号，MAX_ACCOUNTS 可调整；扩大容量前需评估平台配额。没有自动升级付费套餐。
- 登录限流：全站 120 次/小时，单 IP 8 次/10 分钟，单账号 5 次/10 分钟。手动执行每账号 1 次/分钟、6 次/UTC 日。记录保留 30 天。
- 删除是在线数据删除；平台备份保留由 Cloudflare 控制。运营者管理 MASTER_SECRET，拥有服务端解密能力。
- Zepp 协议变化或限制可能导致登录/提交失败；本项目是第三方工具。

## 开发与部署

需要 Node.js 24 和 Wrangler 4。本地 .dev.vars 设置随机 MASTER_SECRET，禁止提交此文件。

```sh
npm ci
npm test
npx wrangler d1 migrations apply mimotion-users --local
npx wrangler dev --var APP_ORIGIN:http://localhost:8787
```

本地 Secure cookie 行为取决于浏览器，必要时使用本地 HTTPS。新部署先创建 D1 和 Queue，更新 wrangler.jsonc 中 account_id、database_id、队列名称与 APP_ORIGIN。

```sh
npx wrangler secret put MASTER_SECRET
npx wrangler d1 migrations apply mimotion-users --remote
npm test
npx wrangler deploy
```

MASTER_SECRET 必须安全备份，变更会使旧凭据及会话不可解密。不要提交密钥、.dev.vars 或本地数据库。

## 迁移和更新

网站的 GitHub OAuth 与保存 Secrets 接口已移除，旧 KV 绑定已移除。用户重新登录 Zepp 并设置计划；不读取旧 GitHub Secrets。

仓库 run.yml 改为仅手动触发，避免与多用户云端计划重复执行。原 Python 脚本与旧配置保留供维护参考。github.js 和互操作测试是旧版兼容代码，不打包进当前 Worker。

修改 dashboard 后运行 npm test，再用 npx wrangler deploy 发布。GitHub 保存源码不等于自动部署。数据库变更新增迁移文件，不修改已经应用的迁移。

## 测试

Node 内置测试与真实 SQLite 覆盖跨用户访问、并发、重复投递、超时、凭据失效、限流、200 账号批量调度与任务补发。Zepp 使用模拟响应，测试不会修改真实账号步数。
