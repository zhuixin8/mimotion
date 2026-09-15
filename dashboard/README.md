# MiMotion 个人网页

线上地址：https://mimotion-dashboard.113618446.workers.dev

GitHub App OAuth 登录，只允许 GitHub 用户 ID `48154595` 管理 `zhuixin8/mimotion`。

## 首次使用

1. 使用部署者提供的专属初始化链接。初始化密钥在 URL fragment 中，由页面清除；不会随页面请求发送或进入 Referer。
2. 点击创建 GitHub App，在 `zhuixin8` 名下创建私有应用。
3. 安装时选择 **Only select repositories → mimotion**。
4. 返回网页，使用 GitHub 登录。
5. 填写 Zepp Life 账号、密码和步数范围，验证后保存并运行。

应用需要 Secrets 和 Actions 的读写权限，以及 Metadata 读取权限。没有代码写入权限。
网页会替换 CONFIG 为单账号配置，原有通知和多账号设置不会自动保留。页面会明确要求勾选此说明。

## 数据与权限

- GitHub 应用客户端密钥在 KV 中使用 Worker Secret `MASTER_SECRET` 加密。注册返回的应用私钥不保留；请求使用用户授权令牌。
- GitHub 会话保存在 AES-GCM 加密的 Secure、HttpOnly Cookie 中，最长 1 小时。OAuth 校验 state，写操作校验 Origin 与 CSRF。
- Zepp 登录草稿在 KV 中加密存储，10 分钟后过期。成功保存或退出后删除。
- CONFIG、AES_KEY、LOGIN_TOKENS 使用 GitHub 仓库公钥加密后写入 Secrets。
- LOGIN_TOKENS 为 AES-CBC 加密缓存的 Base64，与 Python 脚本保持兼容。Actions 合并网页缓存和本地更新的缓存，以较新的登录时间为准。
- 不打印密码、令牌、原始远端错误、请求正文；关闭 Worker 自动 invocation 日志。
- UI 显示 GitHub 工作流状态，不把排队/调度请求视为步数同步成功。
- GitHub 不支持多 Secret 原子更新。中断时页面显示已确认保存的项；在草稿有效期内重试可以补全。网络超时的当前请求结果可能不确定。

## 开发和部署

```sh
npm ci
npm run build
npm test
npx wrangler types
npx wrangler deploy
```

Worker Secrets：`MASTER_SECRET`、`BOOTSTRAP_TOKEN`，均为随机生成的 32 字节密钥。
不要把真实密钥写入配置、源码或提交记录。`.dev.vars`、构建产物和依赖目录均忽略。
GitHub App 配置在首次成功创建后锁定；重新初始化需由管理员通过 Cloudflare 管理资源。

只有真实账号在 Zepp 完成验证后，才能证明端到端可用；测试使用模拟响应，不发送真实步数。
