# Qoder / Qoder CN 桌面版实时限额（0.4.x 日志兜底）

本文说明 Qoder Desktop 0.4.x（国际版与国内版）如何把账号额度写入本地日志，以及 TokenTracker 如何在不读取凭据的前提下读取它。

## 背景

0.4.x 移除了旧版 `SharedClientCache/.info.json` 本地 JSON-RPC，因此 `src/lib/qoder-limits.js` 原有的 `credit/usage` / `auth/status` 链路在桌面-only 环境会返回 `configured:false`。

桌面进程还会监听一个随机的 `127.0.0.1:<port>`，端口只写在 `<data-root>/logs/<session>/mcp/router*.log` 的 `MCP Router started {"port":NNNNN}` 行里。这个端口属于 MCP Router，`GET /` 返回 401；它不是额度接口。TokenTracker 不解析该端口，也不尝试认证。

真正可用的额度来源是桌面自己的账号用量摘要：

```text
[2026-10-27T23:50:41.656Z] [INFO] [main] [Auth] [AccountUsage] ... {"operation":"account.getQuotaUsage",...,"qoderUsage":{"userType":"...","expiresAt":...,"isQuotaExceeded":false,"userQuota":{...},"addOnQuota":{...}}}
```

## 数据位置

按版本隔离读取，不会把国际版和国内版混在一起：

| 版本 | macOS | Windows | Linux |
|---|---|---|---|
| 国际版 | `~/Library/Application Support/com.qoder.app.stable/logs` | `%APPDATA%\com.qoder.app.stable\logs` | `~/.config/com.qoder.app.stable/logs` |
| 国内版 | `~/Library/Application Support/com.qodercn.app.stable/logs` | `%APPDATA%\com.qodercn.app.stable\logs` | `~/.config/com.qodercn.app.stable/logs` |

旧目录 `Qoder/logs`、`QoderCN/logs` 仍然保留，用于旧版 `renderer.log`。

`QODER_LOG_ROOT` / `QODER_CN_LOG_ROOT` 可覆盖日志根目录；`QODER_HOME` / `QODER_CN_HOME` 仍按旧行为指向数据根目录下的 `logs/`。

## 读取规则

`readQoderLocalQuota()` 会：

1. 收集新旧目录中的 `main.log` 与 `renderer.log`，按修改时间从新到旧；
2. 从文件尾部向前按 512 KiB 分块扫描，最多 8 MiB，避免整文件读取，也不假设摘要就在文件末尾；
3. 在每个文件中优先匹配 `[Auth] [AccountUsage]` JSON 摘要；找不到再回退到旧 `renderer.log` 的文本格式。JSON 摘要的映射为：
   - `qoderUsage.userQuota` → `primary_window`
   - `qoderUsage.addOnQuota` → `tertiary_window`
   - `expiresAt` 的 9999 哨兵值 → `reset_at: null`
   - 复用 `normalizeQoderRpcUsage()`，不做第二套百分比/单位推导
4. 只接受 7 天内的快照：JSON 行优先用行首时间戳，旧文本格式用文件 mtime，避免读到很久以前的 `0/0`；
5. 结果写入现有 last-good 缓存（`~/.tokentracker/tracker/qoder-usage-limits-cache.json`，CN 使用独立 namespace）。

这条链路不读取 `auth.v1.dat`、Electron safeStorage、cookie 或任何 token，也不访问网络。

## 触发条件与限制

- 桌面通常只在需要展示额度时才请求账号用量，因此**先打开一次 Qoder 的 Credits / 用量页面**，让 `main.log` 写入摘要；之后 TokenTracker 会从缓存继续读取。
- 日志格式不是公开契约，可能随 Qoder 版本变化；解析失败会静默回退，不影响其他限额源。
- 缓存仍遵循原有 TTL：无 `reset_at` 的窗口保留 12 小时；带未来 `reset_at` 的窗口保留到 `reset_at`，整体缓存超过 7 天且没有未过期的日期窗口时丢弃。
- 只有用量面板触发过请求、或日志被轮转清理时，桌面-only 环境可能暂时没有数据；可设置 `QODER_COOKIE` / `QODER_CN_COOKIE`，国内版也可登录 Qoder CN CLI（见 [qoder-cn-limits.md](qoder-cn-limits.md)）。

## 本地 credit 消耗（transcript sidecar）

限额是账号侧的“还能用多少”，与本地实际消耗是两件事。

Qoder 2026-08 起（app 0.1.2+）不再写 `SharedClientCache/local.db`，会话记录改为
`~/.qoder/projects/<slug>/<sessionId>.jsonl`（国内版为 `~/.qoder-cn/projects`）。这些 JSONL 的
`message.usage` 只有 credit 字段，token 列全部为 0：

```json
{"input_tokens":0,"output_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,
 "credits":3.2,"original_credits":3.2,"billable":false,"context_usage_ratio":0.31}
```

`parseQoderNewIncremental` 因此只把这类行计为活动（`conversation_count`），不伪造 token，也不计算
成本；credit 汇总写入队列旁边的 `~/.tokentracker/tracker/qoder-credits.json`（CN 为
`qoder-cn-credits.json`；POSIX 下属主可读写 `0600`，Windows 上 POSIX 权限位不起作用，访问由 NTFS ACL
决定）。sidecar 形状与 Kiro 共用同一份写入器：每个安装目录一条
`installs` 记录（Windows 上该键按大小写归一，避免同一目录被记成两个安装），顶层给出合计，30 天未更新的安装会被剔除。

- `usage-limits` 用 `readQoderCreditsSummary()` 读回，并通过 `withQoderTrackedCredits()` 合并到
  `qoder` / `qoderCn` 面板数据；用量面板以「Local usage: N credits · M turns」一行展示。
- 0.4.x 桌面环境拿不到 `SharedClientCache/.info.json`，限额链路会返回 `configured:false`。此时只要
  sidecar 存在（说明本地确实解析过会话），面板仍显示本地消耗，而不是“未连接”。
- 不存在官方的 credit→token 或 credit→USD 汇率，所以这个数字始终以 credit 为单位呈现，任何换算都会是猜测。
- 归零只在“目录还在、里面没有 transcript”时发生：那说明安装仍在、消耗停了。若目录本身不存在，或某个
  文件读失败（权限、未挂载的卷），这次扫描不构成证据，保留上一次的值，宁可滞后也不虚报成 0。
- 隐私边界：sidecar 只含数量与时间，不含提示词或回复内容；但 `installs` 的键是安装目录的绝对路径
  （如 `/Users/<name>/.qoder/projects`），分享该文件前请先去掉这个键。

回归测试：`node --test test/qoder-new-parser.test.js`（去重、幂等、多安装、CN 独立文件、读取失败不压低总数）、
`node --test test/sync-qoder-credits.test.js`（清空目录归零、目录缺失保留原值）与
`node --test test/usage-limits.test.js`（`getUsageLimits` 在限额超时或不可用时仍上报本地 credit）。

## 验证证据

2026-10-29 在 macOS 上用 Qoder CN Desktop 0.4.11 实测：

- `com.qodercn.app.stable/logs/<session>/main.log` 含完整的 `qoderUsage` 摘要（`userQuota` + `addOnQuota`）；
- 同一会话的 `mcp/router.log` 端口与 `lsof` 监听端口一致，`GET /` 返回 401，确认它是 MCP Router 而不是额度接口；
- 国际版 `app.asar` 中存在同构的 `hasQoderUsage` / `qoderUsage` / `userQuota` / `addOnQuota` 摘要整形代码。

回归测试：`node --test test/qoder-limits.test.js` 覆盖现代目录、版本隔离、新旧日志优先级、7 天新鲜度、旧格式回退和 `fetchQoderLimits` 端到端回退。
