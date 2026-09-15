# MiMotion 多用户网页版

直接用 Zepp Life 邮箱/手机号及密码登录，首次成功自动创建本站账号，不需要 GitHub 账号或邀请码。网站不会创建 Zepp 官方账号。

## SaaS 使用期与管理后台

用户入口 `/`，管理入口 `/admin`。用户用 Zepp Life 登录后兑换激活码；管理员使用独立的随机管理密钥。

- 已有账号在 0004_saas.sql 应用时赠送 7 天过渡期，只执行一次。新账号没有自动赠送时长。
- 每个激活码兑换一次，时长 1–3650 天，后台每批生成 1–20 个，可设置最晚兑换时间。未到期从原到期时间追加，已到期从兑换当刻开始；一天按 24 小时计算。
- 条件 UPDATE 和 SQLite trigger 在同一事务中消费激活码、增加使用期、写入兑换凭据与审计。本人重复提交同一个已兑换码不会再次加时；多人并发兑换只有一人成功。
- 服务端有效期检查覆盖手动任务、连接测试、再次核对、定时调度、队列消费及实际提交前。已发出的上游请求无法撤回。
- 到期仍可登录、查看记录、兑换续期、关闭计划和删除 Zepp 资料。停用账号需管理员恢复后才能兑换。到期保留自动计划开关，续期后已开启的计划可继续。
- 删除 Zepp 资料会删除凭据、设置和执行记录，保留使用期、停用状态及兑换账本；同一 Zepp 身份再次登录继续关联，不能通过删除注册绕过权限。
- 后台支持生成/下载/查看激活码、停用未兑换码、查找用户、追加天数/设置到期时间、停用/恢复用户、查看审计记录。调整权限校验 revision，避免覆盖同时发生的续期。
- 激活码查找使用 SHA-256 摘要，完整码用 AES-GCM 加密供管理员取回。日志不含明文激活码、Zepp 凭据或管理密钥。
- 管理密钥由 32 个随机字节产生（256 位熵），数据库只存加用途前缀的 SHA-256 摘要；作为高强度访问密钥，不接受弱口令。后台会话独立 cookie/加密用途，有效期 2 小时，具备 CSRF、同源校验和登录限流。更换密钥或退出撤销旧会话。

### 首次配置管理员

先应用迁移，然后在可信电脑运行，私密文件放到仓库外：

```sh
node scripts/provision-admin.mjs --credential-file /private/admin-access.txt --sql-file /private/admin-init.sql --origin https://your-site.example
npx wrangler d1 execute mimotion-users --remote --file /private/admin-init.sql
```

此脚本不会覆盖已有管理员或私密文件。请将管理密钥保存到密码管理器，在后台“管理安全”可轮换密钥。禁止提交生成的文件。当前实现为激活码授权与人工分发，不包含在线支付或自动售卡。

## 使用

1. 登录自己的 Zepp Life，兑换激活码开通后设置每日步数范围。
2. 勾选自动执行并保存。首次登录默认暂停。
3. 点击立即执行，可在网页查看结果。关闭网页或退出登录不影响已开启的计划。
4. 凭据失效会暂停计划，重新登录后需要再次开启。
5. 删除本站 Zepp 资料会清除凭据、设置和执行记录，停止后续任务；使用期与兑换账本保留，不删除 Zepp 官方账号。

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


## 登录测试与效果核对

使用期有效时，登录成功会安排只读连接测试：刷新凭据、验证用户数据接口、读取北京时间当天步数，不提交任何步数。可在账号面板重新测试，结果进入自己的执行记录。

“执行一次并核对效果”使用已保存计划。先读取云端基线，避免提交比已读步数更小的值；提交后再读回一次。提交响应和核对证据分别保存：

- status=success：提交接口接受了请求；不会单凭此值宣称同步完成。
- verification=matched：同一天的读回步数不低于目标。
- verification=below_target：读回数值暂时较低，可能尚未同步。
- verification=unavailable：查询失败、当天数据缺失、格式未知或多条记录冲突；不将它转换成零。

记录中的“重新核对”仅查询原记录日期的云端数据，更新核对时间和数值，并追加一条只读测试记录，不再次提交。读回数值不能证明变化只由本次请求导致，也不能证明微信或支付宝已经同步。

记录支持按类型、数据日期筛选，每页 30 条；首页执行中每 3 秒刷新、空闲每 30 秒刷新，翻页暂停自动刷新。展开后显示提交前后数值、变化量、目标、任务编号与时间。诊断记录不计入今日步数执行统计。

读取协议参考项目作者的实现：[zepp-health-cli 的 band_data 参数](https://github.com/m4ary/zepp-health-cli/blob/main/zepp_health.py)、[zepp_to_influxdb 的按日 summary 解码](https://github.com/bentasker/zepp_to_influxdb/blob/main/app/mifit_to_influxdb.py)。本站只解析目标日期的步数，忽略其他健康数据，不存储原始响应。
