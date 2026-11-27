# 登录状态连续性方案

直接把 Vercel 前端从 InsForge 指向 Cloudflare 会让旧 access token 和 refresh token 失效。当前迁移使用过渡桥接，避免在线用户集体掉登录。

## 并行期间

`TT_LEGACY_AUTH_MODE=parallel` 是默认配置。Cloudflare 向 InsForge 验证旧 access token，并通过迁移后的原 UUID 读取账号。客户端继续向 InsForge 刷新旧会话和退出登录。

## 正式切换期间

在准备交换旧会话时，设置 `TT_LEGACY_AUTH_MODE=exchange`。

1. TokenTracker 账号 UUID、GitHub/Google subject 和邮箱先迁移到 D1。
2. Cloudflare Worker 在过渡窗口内用 InsForge JWKS 验证旧 RS256 access token，并按原 UUID 查找 D1 账号。
3. Cloudflare 的 `/api/auth/sessions/current` 和业务 API 接受已验证的旧 access token，因此用户当前页面不用重新登录。
4. 旧 refresh token 到期或客户端主动刷新时，Cloudflare Worker 将 refresh 请求通过 HTTPS 转发到旧 InsForge。
5. Worker 读取旧响应中的原用户 ID，签发新的 Cloudflare access token、refresh token 和 D1 session。
6. 客户端收到新 token 后继续请求 Cloudflare。旧 refresh token 只在桥接窗口中使用。

旧 refresh token 不写入 D1，不写日志，也不进入前端代码。Cloudflare 只保存新 session 的摘要。

## 开关和截止时间

只有设置 `TT_LEGACY_AUTH_ENABLED=1` 时，Cloudflare 配置才会绑定桥接变量：

- `LEGACY_AUTH_ORIGIN` 指向旧 InsForge 项目。
- `LEGACY_AUTH_JWKS_URL` 指向旧项目的 `/.well-known/jwks.json`。
- `LEGACY_AUTH_ANON_KEY` 通过 Cloudflare secret binding 注入。
- `TT_LEGACY_AUTH_EXPIRES_AT` 为切换窗口结束时间的 Unix 秒数。桥接开启时，Cloudflare 构建会校验该时间仍在未来。

前端发布版本在迁移窗口设置 `VITE_TOKENTRACKER_SESSION_MIGRATION=1`。在 `www.tokentracker.cc` 从官方 InsForge 迁往 `api.tokentracker.cc` 时，先尝试恢复已有的 Cloudflare 会话。如果新域名没有认证 Cookie，SDK 会回到原 InsForge 域名使用旧 Cookie 续签，再把短期 access token 发送给 Cloudflare 的 `/api/auth/session-migrate`。Cloudflare 联系原服务验证当前账号，并为同一 UUID 签发自己的 HttpOnly Cookie。交换失败可重试，成功或主动退出后停止从旧服务恢复。桌面端继续通过它的本地会话代理恢复登录。普通的自托管实例切换仍然清理旧 session。

## 验收要求

在 QA 先验证：

- 旧 access token 访问 `/api/auth/sessions/current` 返回原用户 ID。
- 旧 refresh token 调用 `/api/auth/refresh` 返回 Cloudflare token。
- 新 token 能访问账户报告和设备上传。
- refresh 重放遵守旧 InsForge 的轮换规则。
- logout 后旧、新 access token 和 refresh token 都不能继续访问。
- 两个用户的 session、设备和报告互相隔离。
- Web 从旧域名继续登录时，SDK 分别使用两个域名对应的 Cookie，并在 Cloudflare 刷新后保留原用户 ID。

生产切换前，必须让一名已有登录用户保持旧 cookie 打开页面，确认页面刷新后仍在原账号，并读回原账号的历史报告。桥接截止后再关闭 `LEGACY_AUTH_ENABLED`。
