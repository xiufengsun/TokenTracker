# 将 TokenTracker 部署到自己的服务器

自部署软件免费。你可以在自己的 VPS 上运行同步后端，服务器、域名和备份费用由你支付，升级和维护也由你负责。Managed Cloud 收取的是托管服务费，TokenTracker 仍遵循 MIT 开源许可。

**当前状态为技术预览。** InsForge 本身支持 Docker Compose 自部署，但仓库还没有一套在空白 VPS 上验证过的完整 TokenTracker 安装包。这份文档说明部署准备、已有配置和待完成的步骤，还不是一键安装教程。[InsForge 官方自部署说明](https://github.com/InsForge/InsForge#self-hosted-docker-compose)

[English](self-hosting.md) · [实现状态](self-hosting-status.md)

## 选择使用方式

| 方案 | 需要自己维护什么 | TokenTracker 软件费用 | 数据范围 |
| --- | --- | --- | --- |
| 本地使用 | 每台设备上的应用 | 免费 | 各设备的本地用量 |
| Managed Cloud | 无需维护服务器 | 托管订阅 | 官方 Cloud 账户 |
| 自部署 | 自有后端和 Web 仪表盘 | 免费 | 自有实例的账户与设备 |

自部署实例拥有独立账户系统，与官方公共排行榜分开。账户、用量和排名不会自动导入官方服务。本地采集、成本计算和本地导出不需要服务器。

## 哪些代码已经开源

仓库包含客户端、后端 TypeScript 和 SQL 源码。`17247d9d` 的历史清单为 23 个后端入口和 33 个迁移；应按所选发行 commit 重新清点，不能当作当前数量。[MIT 许可](../LICENSE)允许使用和修改这些代码。文件已公开，不等于线上部署的每份脚本都与仓库完全一致。

历史迁移是现有数据库上的增量改动，部分文件还包含特定用户群的运营处理或数据修复。**不要在新数据库上直接执行全部历史迁移。** 使用[干净的私有后端安装器](self-hosting-backend.md)。`--sql` 输出带 PostgreSQL 事务的独立文件；`--migration` 由已连接 InsForge 实例的迁移 API 提供事务。

订阅、设备权限、赠送和归档工作保存在 `feat/cloud-subscriptions`，尚未作为收费 Pro 正式发布。干净的私有基础 schema、官方本地 Linux 平台和标准 Dashboard A→C→A 切换已有验收记录；公网 VPS HTTPS 和受支持的原生路由仍需验证。[源码清单与缺口](self-hosting-status.md) · [上线前交接总表](cloud-release-readiness.md)

## 准备 VPS

准备支持 Docker Engine 和 Compose v2 的 Linux 主机、持久化 SSD、域名和 HTTPS。TokenTracker 尚未验证最低 VPS 配置，需要用实际账户数、设备数和数据量测试后再决定生产容量。

InsForge 当前的镜像部署包含 PostgreSQL、PostgREST、InsForge API/管理应用和 Deno 函数运行时。平台会创建自己的认证 schema；TokenTracker 的应用表和函数仍需单独安装。[官方 Compose 源码](https://github.com/InsForge/InsForge/blob/main/deploy/docker-compose/docker-compose.yml)

**仅安装 InsForge 平台时**，按官方教程操作。在独立目录中下载并检查官方 setup 脚本后再运行，选择经过审查的版本，并固定镜像版本或 digest。脚本生成密钥，不会启动服务。将 InsForge 的 `API_BASE_URL`、`VITE_API_BASE_URL` 配置为对外 API 域名，再按官方 Compose 流程启动。[官方 setup 源码](https://github.com/InsForge/InsForge/blob/main/deploy/setup.sh)

API 和管理入口通过 HTTPS 代理与访问控制提供服务，不直接对外开放数据库、PostgREST 或 Deno 端口。管理员密码、数据库密码、JWT 签名密钥、加密密钥和管理 API key 保留在服务器上，前端只使用公开匿名 key。数据库首次初始化后，仅修改 `.env` 不会完成数据库密码轮换。

平台安装后，当前 InsForge CLI 可用 `link --api-base-url`、`--api-key` 直接连接自有实例，不需要新建云账号。这不是 VPS 安装步骤。CLI 0.2.8 实际帮助已确认支持，v2.3.3 README 的 cloud-only 措辞尚未同步。也可用自有管理界面、MCP 和文档化的 API 管理。服务端管理 key 不放进 shell 历史、前端包或截图。[CLI 连接指南](https://docs.insforge.dev/cli-reference/connection)。

## 安装应用

本地分支已提供 `scripts/self-host/` 干净的私有后端安装器和 14 个函数的部署清单。按[后端安装指南](self-hosting-backend.md)执行；实际平台与 VPS 验收仍须单独完成，不能由本地 SQL 测试代替。

1. 安装经过审查的应用表、RPC、索引、触发器、RLS 和权限。核对所选 InsForge 版本的服务端角色、登录角色和匿名角色，不把生产用户、token、订单或封禁记录当作初始化数据。
2. 用 `node scripts/self-host/build-functions.cjs` 构建私有后端，通过自有实例的管理接口部署清单中的 14 个函数。包含设备授权、签发、用量写入、改名、账户读取和免费实例设置，不包含公共社区及支付回调。相对导入已打包，SDK 版本固定。
3. 为函数提供服务端 `INSFORGE_BASE_URL`、`INSFORGE_SERVICE_ROLE_KEY`，以及对应的 `INSFORGE_ANON_KEY`/`ANON_KEY`、`JWT_SECRET` 或 `JWT_PUBLIC_KEY`。实际验证用户 JWT 和服务端数据库权限，不假设自部署的 `ACCESS_API_KEY` 可以直接替换所有现有 edge token。
4. 在自己的实例配置登录方式、会话 cookie、允许访问的来源与回调地址。OAuth 需要自己的应用注册和回调地址，浏览器、CLI 和桌面回调分别验证。若所选登录方式需要发验证邮件或重置邮件，还需配置邮件服务。
5. 将 Web 仪表盘编译到自己的 API 与匿名 key，并提供前端路由回退。自己的域名要能访问 `/device` 和桌面回调页面，逐条核对登录和用量请求的真实目标。
6. 干净安装器会启用明确的免费 `self_hosted` 策略。私有数据仍需登录，不受托管设备数和历史窗口限制，不生成付费订单，也不靠 `preview` 授权。邀请用户前须在实际实例核对这套策略。

私人用量和计划中的归档使用 PostgreSQL。头像等文件上传还需要持久化 InsForge 存储和 bucket 权限，使用默认文件系统或合适的 S3 兼容存储，并纳入备份。[官方存储配置](https://github.com/InsForge/InsForge#5-storage-backends-optional)

个人自部署不需要注册 Stripe、Paddle、微信支付或支付宝商户。若另外向他人销售托管服务，则需要自己的支付配置和验证。

## 客户端配置

静态 Web 构建使用现有变量：

```dotenv
VITE_INSFORGE_BASE_URL=https://api.your-domain.example
VITE_INSFORGE_ANON_KEY=your-instance-public-anon-key
```

替换为自己实例的公开匿名 key。InsForge v2.3.3 生成 `anon_` 后接 40 或 64 位小写十六进制的 opaque key，旧实例可使用 `role=anon` 的 JWT。后端验证实际 key 值，前缀本身不能授予权限。自定义地址缺少自己的 key 时不会回退到官方 key，而会明确报错。管理员、service-role、用户 JWT 和私钥不能用于前端；构建会拒绝这些值，日志不打印输入内容。未配置自定义地址时保留官方默认。兼容原有的 `VITE_TOKENTRACKER_BACKEND_BASE_URL`、`VITE_TOKENTRACKER_BACKEND_ANON_KEY` 配对。[官方 key 验证代码](https://github.com/InsForge/InsForge/blob/v2.3.3/backend/src/services/secrets/secret.service.ts#L637-L718)。

CLI 本地 HTML 在应用模块前同步加载 `/api/runtime-config.js`。公开 descriptor 包含最终 `baseUrl`、`anonKey`、`dashboardUrl` 和可选 `configurationError`，优先于编译时默认值，不含设备 JWT 或服务端凭证。登录自定义实例时会显示目标 host，避免将官方密码误填给另一台服务器。

CLI 支持 `TOKENTRACKER_INSFORGE_BASE_URL`、`TOKENTRACKER_INSFORGE_ANON_KEY`、`TOKENTRACKER_DASHBOARD_URL` 和持久化配置。配置后应核对实际 descriptor 及请求目标。[运行配置](../src/lib/runtime-config.js)、[本地 API](../src/lib/local-api.js)、[前端配置](../dashboard/src/lib/insforge-config.ts)。

前端 SDK 单例绑定服务地址与公开 key。`resetInsforgeClientForInstanceChange()` 清理 SDK 内存会话和 auth/PKCE 命名空间，发出 `tt.insforgeInstanceChanged`，由账号层清理账户缓存和云同步 capability。provider 偏好与本地用量保留，订单恢复和提醒关闭记录按实例、账号分开。新实例需要重新登录，旧 SDK 不能向新实例提供 bearer token。

仅同源 localhost SDK 代理请求带 `x-tokentracker-instance`，直连远程请求保持原协议。HttpOnly refresh cookie 必须由本地代理绑定实例并防止旧响应复活，不能把 JavaScript 清理当成 cookie 隔离。不把官方会话或设备 token 复制到另一后端。

服务端明确返回 `self_hosted` 后，页面显示免费私有实例，不展示官方价格、试用或付款 portal。容量、备份和历史保留由运营者管理，私有路径默认禁用公开 Profile，不向官方服务公开资料。

已经发布的桌面包仍需要配套 CLI 和仪表盘版本。设备授权的实际链接必须指向自己的仪表盘，不能让现有 edge 中的官方地址把自部署用户送到官方账号系统。浏览器、桌面授权、两个实例之间的凭证隔离，以及空白 VPS 都需继续验收，单独构建前端不代表整条链路已完成。

## 怎样才算部署完成

必须通过 VPS 的真实 HTTPS 地址验证：

- 新账户能登录、退出和刷新会话，另一账户不能读取其数据。
- 设备授权链接指向自己的仪表盘，两台客户端能写入同一私人账户，不覆盖彼此的设备身份。
- 同一批次重传不增加总量，修正数据、设备筛选、时区和夏令时、模型成本与本地口径一致。
- 会话到期、设备暂停和后端离线有可恢复的界面，不丢弃本地队列。
- 浏览器和桌面请求都访问所选实例，不把自部署数据写入官方后端或公共榜单。
- 备份能恢复到另一实例，认证、用量、设备身份、文件和必要密钥完整，恢复和升级后总量一致。

单元测试不能代替这些公网 VPS 检查。后续官方 v2.3.3 本地 Linux 实验环境已验证真实认证、私有同步、存储和数据库恢复，见[后端证据](self-hosting-backend.md)。该环境与当前 Windows 工作区不同，不能证明公网部署或打包原生客户端路由。

## 后续维护

将数据库、文件存储、部署配置、加密密钥和签名密钥备份到私人恢复位置，备份与 VPS 分开保存，并测试恢复。数据库和文件备份要对应同一应用与 schema 版本。

只安装经过审查且有执行上限的定时任务，保留失败记录。归档先通过数据一致性、并发和恢复验收，再启用数据搬迁任务。容器正常运行不代表聚合、修复和备份任务都执行成功。[归档启用条件](cloud-usage-archive.md)

升级前记录应用 commit、InsForge 版本和镜像 digest、schema 版本与函数源码。先备份，按明确的升级清单变更，验证客户端和 API 契约，保留兼容的回滚方式。升级 InsForge 时也要检查认证、存储和函数运行时变化。

自部署可以让你控制数据和运行费用，服务可用性、升级和恢复也由你负责。只有[剩余工程门槛](self-hosting-status.md)通过后，才会把完整部署包标为可用。
