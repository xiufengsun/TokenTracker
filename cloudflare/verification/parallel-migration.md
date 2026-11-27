# TokenTracker 并行迁移

并行期间由 InsForge 确认用量上传。旧客户端按原流程上传，新客户端可同时通知 Cloudflare 获取已确认的变更。InsForge 在同一数据库事务中记录变更，Cloudflare 按修订号写入 D1，成功后才确认。请求失败或客户端离线时，Cloudflare 的定时任务继续补同步。

## 本地验收

```powershell
npm ci
npm ci --prefix dashboard
npm ci --prefix cloudflare/worker
npm run typecheck --prefix cloudflare/worker
npm test --prefix cloudflare/worker
npm run build --prefix cloudflare/worker
node cloudflare/worker/test/parallel-backends.mjs
npm run typecheck --prefix dashboard
npm test --prefix dashboard
python cloudflare/scripts/test/test_snapshot_delta.py -v
```

联通测试使用 PGlite PostgreSQL 和 Workerd D1，覆盖旧客户端上传、新客户端双写、Cloudflare 暂时不可用、重复和乱序提交、用量统计、登录保持及账号隔离。Windows 的升级测试分别使用旧安装包和新安装包的 `EmbeddedServer` 目录，检查动态端口变化后原会话仍可使用。

```powershell
node cloudflare/worker/test/windows-embedded-upgrade.mjs $ttOldEmbeddedServer $ttNewEmbeddedServer
```

## 私有候选环境

1. 在 InsForge 应用用量镜像及设备状态镜像迁移，再部署 `tokentracker-cloudflare-usage-mirror`。设备槽位、别名、合并关系和上传窗口由独立队列持续同步。Cloudflare 逐步提交有关联的记录，并保留指向槽位的独立别名和重置记录。通过各自的后端密钥配置传递同一共享值，InsForge 使用 `TOKENTRACKER_CLOUDFLARE_MIRROR_SECRET`，Cloudflare 使用 `USAGE_MIRROR_SECRET`。
2. 将同一 PostgreSQL 快照中的业务和账号数据导入独立 D1。保留原账号 UUID 和 OAuth 账号对应关系。按 [D1 导入手册](./d1-full-transfer.md) 核对每张表的行数、字段类型和摘要，完成后补同步快照以来的用量变更。
3. 在 Worker 设置 `TT_USAGE_MIRROR_SOURCE_URL`、`TT_LEGACY_AUTH_ENABLED=1`、`TT_LEGACY_AUTH_MODE=parallel` 和 `TT_LEGACY_AUTH_EXPIRES_AT`。镜像源地址使用 InsForge 函数的 HTTPS URL，桥接截止时间使用 Unix 秒。
4. 镜像 Worker 验收通过后，在 InsForge 为 `tokentracker-ingest` 设置 `TOKENTRACKER_CLOUDFLARE_DUAL_WRITE=1`。新客户端收到已提交的上传回执后自动触发 Cloudflare 写入。旧客户端继续由源端队列同步。测试客户端可用同名环境变量 `1` 提前启用或用 `0` 关闭。用 `TOKENTRACKER_CLOUDFLARE_READS=1` 和 Web 的 `VITE_TOKENTRACKER_CLOUDFLARE_READS=1` 分批启用用量报告读取。旧会话的验证、刷新和退出仍由 InsForge 处理。
5. 正式切换前对账账号、订阅和支付等其余业务写入，并验收原账号的会话交换。历史数据以已验证的 D1 快照为基础。 [最终切换](./cutover.md) · [登录状态连续性方案](./auth-continuity.md)

## 正式 OAuth 回调

授权应用显示名使用 **TokenTracker**，应用首页使用 `https://www.tokentracker.cc`。GitHub 和 Google 分别注册 `https://api.tokentracker.cc/api/auth/oauth/callback/github` 和 `https://api.tokentracker.cc/api/auth/oauth/callback/google`。Google Branding 使用已验证的 `tokentracker.cc`。桌面端回调为 `tokentracker://auth/callback`。

正式 Worker 的授权入口只接受 `api.tokentracker.cc`。其他主机请求返回 421。QA 通过 `TT_QA_AUTH_ORIGIN` 使用单独的授权地址，并通过 `tokentracker-qa://auth/callback` 测试桌面回调。验证正式授权页时，应分别检查 GitHub 和 Google 的显示名、回调地址及既有账号关联。

正式 Worker 可先保存未发布版本，并提前配置已回读的 D1、身份映射密钥和旧会话桥接。保持该版本的 `workers.dev` 和版本预览入口关闭。正式授权验收使用生产 GitHub 和 Google 客户端，由各自项目的管理员配置显示名和回调。生产切流还应接入排行榜的审核配置和 Waffo 商户配置，并完成 [切换验收](./cutover.md)。

## Windows 数据迁移

在 Windows 的加密 NTFS 目录中存放 PostgreSQL 归档、身份投影、SQLite 镜像和校验回执。Windows PostgreSQL 的隔离恢复使用 `--socket 127.0.0.1`。连接 InsForge 时使用 `verify-full` 和验证过的 PEM 信任链，Windows libpq 可通过 `TT_MIGRATION_CA_BUNDLE` 指定 CA 文件。

D1 保存运行所需的数据。只作归档的旧表可打包为独立的加密 PostgreSQL 归档，存入同账户下禁用公开访问的 R2，并下载核对密文 SHA-256。归档口令应保留在 Windows 的加密目录中。 [一致性快照导出](./consistent-source-export.md)
