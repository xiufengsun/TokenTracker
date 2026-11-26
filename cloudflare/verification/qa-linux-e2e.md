# QA Linux E2E 验收说明

## 固定目标

所有请求只允许发往：

`https://api-qa-tokentracker-migration-staging.sunxiufeng1992.workers.dev`

测试使用独立合成账号和隔离 HOME。禁止使用生产账号、生产 InsForge、真实业务数据、生产 OAuth 应用和生产设备 token。

## 凭据输入

把下面变量放在云电脑本地的 0600 文件中，例如 `~/.tokentracker/qa.env.local`。文件通过安全输入或私有文件交付，不要贴到聊天、终端回显、截图或测试报告。

```sh
TT_QA_BASE_URL=https://api-qa-tokentracker-migration-staging.sunxiufeng1992.workers.dev
TT_QA_ID=<dedicated QA user UUID>
TT_QA_EMAIL=<dedicated QA email>
TT_QA_PASSWORD=<dedicated QA password>
TT_QA_REFRESH_SECRET=<QA-only refresh secret, only for report-preview>
TT_QA_RECEIPT=/tmp/tokentracker-qa-receipt.json
```

GitHub 和 Google OAuth 由系统浏览器完成授权。脚本只读取 `TT_QA_ID` 比对回调后的用户 ID，不读取或打印 provider secret。OAuth client secret 只放在 Cloudflare QA secret binding 中。

## 验收顺序

```sh
set -a
source "$HOME/.tokentracker/qa.env.local"
set +a
cd cloudflare/worker

node test/oauth-provider-preview.mjs github
node test/oauth-provider-preview.mjs google
node test/auth-device-preview.mjs
```

验收点包括系统 OAuth 回调、PKCE 单次兑换、刷新、退出、设备授权、合成用量上传和本人账户报告回读。`auth-device-preview.mjs` 只写一个随机 QA 设备和一个随机用量桶，不触发 trial、公开可见性或 report refresh。

## 跨用户隔离

跨用户验收需要第二个独立 QA 账号。它只通过安全输入提供给云电脑，使用另一份环境文件，不能复用第一个账号的 refresh secret。

- 第二个账号的 access token 访问第一个账号的账户报告必须返回未授权或空结果。
- 第一个账号的 access token 不能重置、读取或修改第二个账号的设备。
- 第一个账号的设备 token 不能写入第二个账号的设备或账户。
- 任何失败响应都要记录 HTTP 状态和错误码，不记录 Authorization header 或响应 token。

设置 `TT_QA_OTHER_ACCESS_TOKEN` 后，脚本会额外验证第二个 QA 账号读取第一个账号设备时只能得到 0。当前仓库已经有专用 QA 账号脚本和匿名/未授权断言。第二个 QA 账号尚未写入本机或仓库，避免自动创建长期凭据。

## 结果文件

只保存脱敏的 JSON 回执、HTTP 状态、错误码、目标 URL 和合成 ID。回执文件权限设为 0600。不要保存 access token、refresh token、密码、OAuth code 或 provider secret。
