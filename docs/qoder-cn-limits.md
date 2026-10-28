# Qoder CN 实时限额

Qoder CN CLI 用户不需要启动桌面 App。TokenTracker 读取 `~/.qoder-cn/.auth/user` 和 `.auth/machine_id`，只在内存解密账号凭据，然后用 Bearer token 请求 `https://openapi.qoder.com.cn/api/v2/quota/usage`。`QODERCN_CONFIG_DIR` 可指定 CLI 的配置根目录，国际版配置与凭据不会参与这条链路。

新版桌面 App（0.4.x）的本地日志兜底、数据目录和 MCP Router 端口结论见 [qoder-desktop-limits.md](qoder-desktop-limits.md)。

设置 `QODERCN_PERSONAL_ACCESS_TOKEN` 时，按官方 CLI 的优先级使用 PAT，通过 `/api/v1/jobToken/exchange` 获取访问令牌。令牌不会写入 TokenTracker 缓存。组织账号使用官方 CLI 的 `/sash/api/v2/me/usage`，只解析包含 `qoderUsage.userQuota` 的额度响应；`enterpriseUsage` 仅含外部账单链接，不伪造额度。

主窗口显示套餐 Credits 的 `used / total`，不混入独立到期的附加包或组织资源包。接口中的百分比为小数比例，主窗口直接从用量与总量计算。旧版桌面 IPC、活动额度缓存、手动 `QODER_CN_COOKIE` 和本地日志保留原有回退行为。CN 官网入口已切换为 `https://qoder.cn`。

## 验证证据

2026-10-12 核查了[官方认证文档](https://docs.qoder.cn/cli/authentication)、[官方用量文档](https://docs.qoder.cn/cli/usage)和官方 npm 包 `@qodercn-ai/qoderclicn@1.1.68`。包内 `QoderCredentialStorage` 使用 `.auth/user`，将 `machine_id.trim().slice(0, 16)` 传入 WASM 凭据 codec。隔离运行官方 `credential_storage_encrypt / credential_storage_decrypt` 对非敏感 fixture 完成 roundtrip，证明其密文与 Node `aes-128-cbc` 一致，key 和 IV 都是上述 16 字节。回归测试保留了由官方 WASM 生成的合成密文，不依赖包内变量名或运行时加载 CLI 代码。

真实公网探测得到 `/api/v2/quota/usage` 未认证 HTTP 401、`TOKEN_INVALID`，PAT 交换无效值 HTTP 400，`qoder.cn` 网站用量入口未认证 HTTP 401。已有 Qoder 国际版回归测试和 CN CLI 凭据、PAT、额度、缓存、过期认证测试通过。

本机没有 CN CLI 登录态；新版 CN App 0.4.11 的桌面日志已实测（见 [qoder-desktop-limits.md](qoder-desktop-limits.md)），真实登录账号的额度与官方 `/usage` 对账仍待验证。新版桌面 App 使用 Electron `safeStorage` 的 `auth.v1.dat`，当前不直接读取该文件；CLI 路径和桌面日志路径都不依赖它。TokenTracker 不刷新或改写 Qoder 的凭据，过期时沿用已有缓存或提示重新登录 CLI。
