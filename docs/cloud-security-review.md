# Cloud / Pro 安全扫描逐项审查

后续受审来源 c93c9080 已通过完整 CI 与 CodeQL gate 113997145048（0 新注释）；222 在 PR 自动 fixed，未人工 dismiss，分支剩 14 条主干已有 open。完整 handler 57 项相关目标组与实际 ESM 产物 7 项通过；正式远端函数尚未部署。下文 c3909232 的 16 条人工判定为此前来源，理由与读回证据继续保留。

2026-10-10。应用候选 c3909232，最新扫描实际 PR merge a9e0c1e6（analysis 1925765564）。第二批五项源码告警自动关闭；人工判定前实际安全 check 113989824128 为 16 条注释（5 high、11 medium），分支 31 open。以下 16 条逐项审查后，5 条以 used in tests、11 条以 false positive 标记并逐条读回确认；该 check 已变为 success，标题为 No new alerts in code changed by this pull request。其历史 annotations_count 仍为 16，不写成原始扫描零告警；分支仍有 15 条主干已有 open 告警，未一并忽略。证据 acceptance-security-reviewed-adjudications.json。验收状态以 [上线前总表](cloud-release-readiness.md) 和对应 GitHub check 为准。未禁用查询或批量忽略目录。

## 已通过代码修复处理

| 告警编号 | 问题与改动 | 证据与边界 |
| --- | --- | --- |
| 292 | Bearer 解析重叠正则改为仅匹配前缀 | d9c0226f 自动不再报出；畸形值隔离进程探针，不声称 Node HTTP parser 可接受换行 header |
| 297 | 静态资源 stat 后再次按路径读取 | 同一 FileHandle 检查、读取/流式输出；原版本替换回归失败，修复后通过 |
| 294 | gift admin 凭据/resume 路径检查后读取 | O_NOFOLLOW/O_NONBLOCK、同 descriptor 类型/owner/mode/大小检查与限量读取；Linux/macOS 三项新回归实际通过；Windows ACL 入口仍关闭 |
| 293、312 | 支付测试使用宽松 URL 字符串条件 | 精确解析并比较 origin；没有作为生产 URL 防护的替代 |
| 296 | 修复设备身份时直接按配置路径写入 | c3909232 使用 wx/0600 随机临时文件后原子替换；保留旧文件、碰撞文件及失败清理回归 |
| 295 | Windows 包清单 stat 大小与读取 hash 不同来源 | c3909232 从同一 buffer 获取大小/hash；须由该源码 CI 包实际验收 |
| 239 | Bot 构建使用可预测共享临时文件 | c3909232 独立 mkdtemp，清理仅自己创建的两文件和目录；旧 PID 邻居文件回归在原版本失败 |
| 217 | WorkBuddy trace 检查和读取可能对应不同文件 | c3909232 open/fstat/read 同一 descriptor，并 finally 关闭；旧源码替换回归失败，新源码通过且第二次增量读取替换文件、第三次去重 |
| 160 | 未知代理异常通过 String(error) 输出 | c3909232 只取限长首行 message 或通用信息；未知异常 toString 不调用，多行内容不返回 |

303、304 在第一批修复后不再报告。它们属于 gift CLI 的凭据到授权 HTTP 流；descriptor API 改动使扫描器不再识别原文件来源，不能仅凭消失声称授权访问风险已消除。真实凭据仅发往已验证的管理员选择后端，Windows 私有凭据入口保持原限制。

## 预期文件/网络流程的人工判定依据

以下依据取自完整 SARIF 数据流、实际源码和现有回归。GitHub 每条标记及读回结果另存本机验收证据；这些是人工判定，不能写为扫描自动修复。

| 编号 | 实际流与安全边界 | 对应验证 |
| --- | --- | --- |
| 305 | 私有 config 中用户选择的 baseUrl 到 auth 请求 URL；不是发送 config 全文 | runtime-config 校验 HTTPS 或 HTTP loopback、无凭据/query/fragment；自部署本来允许 Owner 选择后端；无效配置 fail closed，redirect=manual |
| 306 | 同一 config 的 public anon key 到该实例 apikey header | privileged ik_/非 anon 拒绝；公钥与所选实例绑定；两真实本机 HTTP 实例之间 cookie/key/bearer/capability 不串用 |
| 307 | 同一 baseUrl 到 stale-CSRF refresh rescue URL | 固定 auth 路径，redirect=manual；runtime fingerprint、账号 generation 与返回前重新核对配置；晚到响应不能恢复前一实例凭据 |
| 310 | browser Authorization 中的账号标识经 token issuance 到固定 cloud-device-token.json 内容 | 上游发行必须成功，expected owner/实例/机器匹配，晚到发行和登出禁止写入新账号缓存；文件路径不来自请求，wx/0600 随机临时文件原子替换；这是预期 JSON 凭据缓存，不执行内容 |
| 311 | 同一验证后的 ownerId/baseUrl 到固定 cloud-upload-owner.json 内容 | 本地 mutation 认证、cloud session/generation、同步偏好和发行成功检查后记录绑定；请求不能提供文件名；用于账号切换后重放自己的上传游标，不执行内容 |
| 299 | hosted QA 工具读私有 .insforge/project.json 的 API key 到授权请求 header | origin 必须精确为既有 srctyff5 项目，固定 QA RPC 前缀、redirect=error；是管理员工具授权访问，非浏览器接收凭据 |
| 300 | 同工具读 archive/storage/logical checkpoint 的 operation UUID 以及自己的 logical backup 到 QA RPC 参数 | checkpoint scope/sentinel 精确匹配；logical backup checksum 匹配；命名 QA RPC、绑定允许用户/设备、幂等 operation；服务端恢复检查 snapshot owner、已拥有设备和最多 2000 行，并拒绝覆盖后来上传数据；发送自己备份是恢复演练所需，不执行文件内容 |
| 301 | 同工具 API key 到 scoped read header | 精确项目 origin、固定表允许集合；调用位置仅 exact QA user 或来自其 sandbox 订单的已验证 UUID 集合；device-token snapshot 列集合不包含原始 token；redirect=error |
| 302 | 通用维护 CLI 读 checkpoint 的 device ID 到 maintenance RPC 参数 | 与当前 user/device/day/action/limit/baseUrl scope 完整匹配；默认 dry-run；apply 仅 loopback，erase-user 须匹配确认；RPC 有界且 redirect=error；预期上传操作元数据而非任意文件 |
| 308 | maintenance RPC 结果到操作者指定 checkpoint 的 JSON 内容 | 随机 wx/0600 临时文件后 rename；响应不控制 checkpoint 路径，不执行 JSON；最多指定 limit 数任务，resume 精确 scope；通用 HTTP-to-file 规则对预期持久化的匹配 |
| 309 | hosted QA RPC 结果到 archive evidence JSON | 目标目录固定、文件名 archive-[a-z0-9-]+.json、随机 wx/0600 临时文件后 rename；服务端响应只成为 JSON 内容，不控制路径/执行 |

主要回归：test/self-host-instance-config.test.js 的两个实例隔离、custom→official 切换、晚到 auth、privileged/损坏配置拒绝；test/local-device-token-cache.test.js 的账号证明、登出取消、晚到发行/上传、401 撤销与 403/503 保留；test/cloud-device-token.test.js 的 owner/base/machine 精确匹配；test/cloud-usage-archive-runner.test.js 的有界 dry-run/apply、lost-response 恢复、erase 确认、hosted apply 拒绝和真实 HTTP redirect 不泄漏凭据。

## 隔离测试夹具的路径告警

| 编号 | 依据 |
| --- | --- |
| 298 | test/upload-throttle.test.js 在自己 mkdtemp 的队列文件中先量 size，再故意 append 来检验 pending bytes；不存在基于攻击者可控共享路径的授权判断或生产写入 |
| 282 | test/local-device-token-cache.test.js 先断言登出后 ENOENT，再进行新账号正常登录/发行，随后读取新账号文件；负断言不是允许后续访问的授权检查 |
| 283、284 | 同一隔离夹具先断言 401 后 ENOENT，再重启代理实际发行替代 token；403 后读取并验证 token 保留；不依赖此前存在性结果打开文件，正是在验证文件被删除及重新创建的产品行为 |
| 313 | test/atomic-json.test.js 在自己 mkdtemp 中创建文件链接，执行被测原子替换后分别断言旧目标未修改、新路径不是链接且含新 JSON；lstat 是测试结果断言，不是生产授权检查，也不决定下一步是否允许读共享路径 |

这五条所在文件只操作 mkdtemp 夹具和自己的 loopback 测试服务器。Linux CI 已实际执行新增链接替换断言。不能为消除告警而删去账号隔离、撤销或节流断言。

## 独立保留的主干告警

上述审查针对 PR 门禁匹配到的具体流；没有把主干的其他 provider/cache/测试告警一并忽略。主干 open 数、分支 open 数、PR 新注释数分别记录，不混为同一指标。usage-limits 的 TLS 例外仅针对固定 127.0.0.1 的本机 Codeium 服务，不能把它当作远端 HTTPS 允许关闭验证的依据。未完成的告警仍需自己的源码与回归证据。

后续已修复 222：leaderboard-refresh 三个 catch 不再将未知异常 String(error) 或内部 error.message 返回 HTTP，改为操作固定错误。新增完整 handler 回归在旧源码实际 6 失败/1 通过，修复后及相关 guardrail/pricing/compact-wire 57/57；新完整 CI 与 CodeQL gate 已通过，222 在 PR 自动 fixed，正式函数尚未部署。这是代码修复，未按误报关闭。其他 provider 授权/缓存流亦须各自核对目标、重定向、固定路径及回归；本文的 11 条预期流程判定不能套用到它们。

CodeQL 官方规则：[文件到 HTTP](https://codeql.github.com/codeql-query-help/javascript/js-file-access-to-http/)、[HTTP 到文件](https://codeql.github.com/codeql-query-help/javascript/js-http-to-file-access/)、[文件检查/使用竞态](https://codeql.github.com/codeql-query-help/javascript/js-file-system-race/)。它们要求判断数据流是否符合应用预期；这里逐条保留具体边界，不把扫描静默作为发布证据。
