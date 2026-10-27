# TokenTracker 全项目双审查报告(2026-09-05)

方法:5 轮严格双审查,每轮 2 名独立只读审查员(不同视角),轮间合并发现、后续轮验证前轮结论,第 5 轮为全量裁定 + SHIP/NO-SHIP 签核。共 10 个独立审查视角 + 2 名终审。所有发现均要求 file:line 级证据,关键项由主审复核亲验。

范围:① 未提交工作(Silent Start 开关三平台 + macOS Dev 变体隔离,15 改动文件 + 3 新源文件);② 全项目(CLI 数据管线、dashboard、edge functions、三平台原生壳、安全/隐私、发布/CI)。

累计账本(过程全记录):`/tmp/tt-review-ledger.md`。

## 签核结论

| 对象 | 结论 |
|---|---|
| 未提交的 Silent Start / Dev 隔离工作 | **SHIP(带条件,见下)** |
| 项目整体(云+本地管线持续运行) | **OPERATE**(无停机级危害) |

测试基线:`npm ci` 后 `npm test` **2603 pass / 0 fail / 2 skip**;`cargo test --lib` 16/16(含 settings.rs 全部 6 个新单测);4 个 validator 全 PASS;Swift 161 执行 / 1 失败(已知的 qoder-labels locale 预存问题)。**记忆中"npm zstd 预存失败"已证伪——那只是 node_modules 缺失假象。**

## 发布前必修(阻断)

1. **F32 [P1] `cargo fmt`** — settings.rs:48,57 过不了 `cargo fmt --check`,ci.yml:110 会红并连锁堵死 npm-publish 与整条发布链。
2. **F1 [P1] Dev 构建更新防线缺口** — TokenTrackerBarApp.swift:173 `UpdateChecker.shared.check(silent: true)` 未包 `#if !DEBUG`。已亲验:silent 路径在 AutoUpdatePolicy 默认开 + 位于 /Applications 时**无提示**下载安装并强制重启、直接 removeItem 替换 /Applications/TokenTracker.app(UpdateChecker.swift:143-156,461-462,404)。菜单/NativeBridge 两处都堵了,这第三条路没堵。
3. **F9 [P1] 版本未 bump** — 九处版本位一致停在 0.95.0 = 已发布 tag v0.95.0(非 draft)。重发必失败("version already consumed")。发布前 `npm version patch|minor`。
4. **F10/F11 [P2/P3] 提交卫生** — `.v2c/`(含本机插件缓存绝对路径)、`out/`、`docs/silent-startup-report.html`(1013 行生成态中文 HTML)未忽略;新源文件(settings.rs / SilentStart.cs / dev-cleanup.sh)须显式 add。

## 随本次 release 强烈建议

5. **F19+F20 [P2] 云端计价漂移且无守护** — 本地 computeRowCost 对 `prime-agent-github-copilot`/`prime-agent-copilot` 返回 $0(pricing/index.js:17-22),5 个 edge 副本的零价守卫只查 `pi-*` 两个别名(如 leaderboard-refresh.ts:426)→ Prime Agent 用户的云端 estimated_cost_usd 虚高(用户可见的错误数据)。且 parity 测试第三用例**正向断言**了这份不完整守卫(test/edge-pricing-parity.test.js)——两处必须一起改,否则修 F19 会把测试打红。
6. **F2 [P2·需 owner 裁定] dev-cleanup.sh 违反 spec §7-2** — spec 行 122 钉死"不得 rm Preferences plist",脚本 :26-29 却在 rm(defaults delete 后清"孤儿文件",注释自辩安全)。二选一:删脚本两行守 spec,或修订 spec 接受此清理。该禁令本身是上一轮双审的决定,默认建议守 spec。

## release train 尽快跟进(预存问题,非本次引入)

7. **F24+F25 [P2/P3] 本地中继缺 Origin/Host 门** — `/api/auth/*`(local-api.js:1681 起)无 `isAuthorizedLocalMutation` 校验且服务端注入 Insforge cookie → 任意网页可盲跨站 POST 骑乘云会话;DNS rebinding 可读响应;`/api/local-auth`(:1575-1586)向任意 loopback GET 发 mutation token。`/proxy/*` 经裁定无恙(仅 ipcheck,GET-only、剥 cookie)。修复 = 中继路由过既有守卫 + loopback Host 钉死。

## 其余发现(带票放行,P3,post-ship)

- **同系统类(一处修三类)**:F6/F16/F22 — settings.rs write_bool 与 server.rs record 写均非原子(撕裂 JSON 静默回退),settings.rs 还整文件覆盖丢未来兄弟键;统一 RMW + tmp + `fs::rename`。
- **Windows/构建**:F33 — TokenTrackerWin.Tests.csproj:20-27 显式 Compile 链表不含 SilentStart.cs(主工程 glob 能编,仅测试零覆盖;一行链入或明示接受);F34 — package.json `version` 脚本硬编码 8 条 git add 路径(VERSION_FILES 第二份拷贝);F35 — 两个 workflow 的 `brew install xcodegen` 未钉版本。
- **Linux**:F7 — 持久化失败仍断言勾选态(tray.rs:57-59、TrayApplicationContext.cs:745-749 同病,回读后断言);F21 — server.rs:604 可预测 /tmp 日志回退无 O_NOFOLLOW;F23 — 首选端口 bind→drop TOCTOU;F17 — 纯建议:Linux P1 自启落地时门须为 `!(silent_start || autostart)`。
- **安全加固(同用户/低触发前置)**:F26 — bundle-node.sh 下载 Node 无 SHASUMS 校验(.ps1 有,照搬);F27 — Windows 日志记完整深链 URL 含 insforge_code(只记 Path);F28 — ServerManager.swift:225-227 zsh -lc 内插 binaryPath(exec "$1" 传参式);F29 — macOS/Windows OAuth 桥开页面给的 URL 无 https 门(Linux oauth.rs 有范本);F30 — 三平台 OAuth 无 state(PKCE 已缓解);F31 — SingleInstance 管道无显式 PipeSecurity(跨用户只读,一行加固)。
- **Dev 隔离/文档卫生**:F3 — Debug 下 dashboard 的 Check for Updates 按钮死点击且 spec"两处入口"实为三处;F4 — WidgetSnapshot.swift:17-19 新注释与 spec §5 矛盾(entitlements 实际无 application-groups);F5 — 四个存量 reloadAllTimelines 在 Debug 仍运行(不写文件,D3 仍成立);F8 — dev-cleanup.sh 漏杀 external-CLI fallback 服务(补 pkill 7681);F12 — spec § 引用悬空/跨文档歧义(dev spec §4 是平铺列表);F13 — 新 Strings 条目 zh-Hant/ja/ko 全英文(spec 认可但破惯例,zh-Hant 可补"靜默啟動");F14 — 四份中文 spec/plan 在 docs/ 根(英文化惯例,可移 specs/ 子目录);F15 — spec 引用 gitignored 的 docs/plans/ 路径;F18 — Windows/Linux 未来 Dev 变体冲突清单(固定 mutex、深链自愈、single-instance id)未记入 spec。

## 已核实健康面(抽样)

computeRowCost 只按五列计价、无调用方绕过;Claude 系 dedup 全走 claudeMessageDedupKey;队列写读语义一致;5 个 edge 的 MODEL_PRICING/getRowPricing 逐字节一致;隐私不变量成立(只出计数/偏移/哈希,上传仅 {hourly, account_session_states});本地服务器仅绑 127.0.0.1;索引内无密钥;CLAUDE.md 发布叙事与 YAML 无漂移(create-release/draft/并行 builder/六资产门/npm-publish SHA 门全属实);Linux oauth 深链校验严格;dev-cleanup.sh 破坏面安全;settings.rs 0700/0600;近 5 个行为型提交无管线回归。

## 未覆盖面(如实)

无 macOS 实机 QA(silent start/dev 共存未真实启动验证);无 Windows 运行时(本机无 dotnet,静态审查);无 dashboard 运行时/e2e;无摄取管线压测与解析器 fuzz;无三平台真机 OAuth 全链路;F24 未做 DNS-rebinding PoC;CI 绿仅单次观测。

## 建议发布序列

显式提交新文件(勿带 .v2c/、out/、report.html)→ `cargo fmt` → F1 一行修复 → (建议)F19+F20 edge 五处+测试 → owner 裁定 F2 → push → CI 绿(npm 自动发)→ `npm version patch`(勿推本地 tag)→ `gh workflow run "release (macOS + Windows + Linux)" -f version=<新版本>` → train 上尽快跟 F24+F25。
