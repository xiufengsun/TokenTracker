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

## 验证证据

2026-10-29 在 macOS 上用 Qoder CN Desktop 0.4.11 实测：

- `com.qodercn.app.stable/logs/<session>/main.log` 含完整的 `qoderUsage` 摘要（`userQuota` + `addOnQuota`）；
- 同一会话的 `mcp/router.log` 端口与 `lsof` 监听端口一致，`GET /` 返回 401，确认它是 MCP Router 而不是额度接口；
- 国际版 `app.asar` 中存在同构的 `hasQoderUsage` / `qoderUsage` / `userQuota` / `addOnQuota` 摘要整形代码。

回归测试：`node --test test/qoder-limits.test.js` 覆盖现代目录、版本隔离、新旧日志优先级、7 天新鲜度、旧格式回退和 `fetchQoderLimits` 端到端回退。
