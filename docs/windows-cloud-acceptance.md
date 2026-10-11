# Windows 客户端验收交接

2026-10-11 当前公开版本为 TokenTracker Cloud（云服务）1.3.3，发行 tag/source 为 `cc934784`。main/CLI/六项桌面资产/正式网站已发布，价格和既有权益标识不变。最新文件、hash、证明与剩余人工/资金验收见[发行总表](cloud-release-readiness.md)。下文原有 Pro 名称、旧源码和 QA 结果是历史记录，保留原始范围，不替代当前安装包的人工验收。

## 统一 1.3.2 发行草稿的 Windows 包，a1f02b08

[统一构建 38062816928](https://github.com/xiufengsun/TokenTracker/actions/runs/38062816928) 的全部五个 job 成功，六项资产与 `SHA256SUMS` 完成。`publish=false` 的公开发行/Homebrew 两个步骤均为 skipped，草稿未公开。版本 tag 精确指向 `a1f02b0889cecde6b0b7490ef8d5f086b996acb2`，不可移动；该提交相对下面 `83e7e0f1` 的应用、原生和打包输入未变化，只新增发行准备开关及文档/测试。

本机已独立下载草稿 Windows ZIP 和 Inno，实际大小/hash 均与 GitHub asset digest 及下载的 `SHA256SUMS` 一致：

| 文件 | 字节 | SHA256 |
| --- | --- | --- |
| TokenTracker-win-x64.zip | 115734466 | `eaf84d33e33df588d516933c0216f5b11191ec0ab06c36f48e08fd7b34f0d16f` |
| TokenTracker-Setup.exe | 81395934 | `afdb4989a148c6f0cc11f5bc7767a2d87193c1ecf97038f3e5384a64640d790b` |

解压后 983 个文件的本地 hash 索引已保存，109 个嵌入 CLI/入口/清单文件与 tag 的 Git blob 逐字节一致，四项现有私钥/管理 key 字节模式零命中、无敏感配置文件或旧本地 preview 地址。`TokenTracker.exe`/`.dll` 为 1.3.2.0，ProductVersion `1.3.2+a1f02b0889cecde6b0b7490ef8d5f086b996acb2`；实际包内 Node22.22.2 的 SHA256 为 `ae1a50511be58e987483fdbc12125407443926d2d394669ade2352776e920dd3`。新发行 ZIP 没有审核 artifact 的外置 manifest，不把这份本地索引写成 983 项外置清单匹配。

私有包在 `.tmp/windows-cloud/release-a1f02b08-download/`，解压目录 `release-a1f02b08-payload/`；证据 `release-final-windows-verification.json`、`release-final-inventory.json`。没有执行新草稿的 EXE 或安装器，下面 83 的 30 窗口/55 包内专项保留原来源，不升级成这个新 ZIP 的 GUI 结果。

接续设备验收应使用这个来源已确认的发行候选：由本人安装并正常登录，然后核对 CSV/JSON 实际保存、同名文件保留、当前账号/实例与迟到结果；由本人完成完整托盘退出/重开、单实例、OS OAuth/付款协议返回、升级/卸载与本地数据保留。此前自动审批拒绝安装、完整托盘及系统协议操作，仅返回 `blocked by policy`，没有更换工具绕过；登录遵循 computer-use 的禁止自动化认证对话框规则。为登录接续打开的 83 临时 Smoke 窗口已主动关闭，其被中止的此次运行不计作新的完整通过结果。本轮不新增支付订单或扣款。

## Windows 侧独立读回与窗口检查，83e7e0f1

2026-10-10 在 Windows 同步并受审 `83e7e0f15dc20a1c210b55a4c81931430be12d63`，版本 1.3.2，应用源码与胶囊版 `39208a10` 相同。[CI 38047796689](https://github.com/xiufengsun/TokenTracker/actions/runs/38047796689) 四个 job 全成功、CodeQL PR check success/0 新注释。已独立下载[该 head 的审核包](https://github.com/xiufengsun/TokenTracker/actions/runs/38047796689/artifacts/11668268148)，归档 196013138 字节、SHA256 `bd566ef9a5e4d09651a04d883fd273b4bfdcef41d3e2b9d18848e6cff787c8dd`，与官方 digest 一致。

实际 checkout `351a42eda82de576ec21bf6c56b34a7f0307d862` 的 Git tree `2ed9da4f30abd055d1e210e7c645e48e2b00ec93` 与受审 head 相同；**983/983 文件大小/hash、109 份嵌入源码 Git blob** 匹配，EXE/DLL 为 1.3.2.0。ZIP 115733589 字节、SHA256 `ccad73a265dba8fa43745168214570edc9c1af6914aae6adef047273e25a1e72`；Inno 安装器 81401363 字节、SHA256 `5bedfb2aef6bb110c47a477f51a778e730701cb47468ec8aa130d98ede9e7f69`。四项本机现有私钥/管理 key 字节模式零命中；不声称覆盖已不在本机的其他凭据。公开 JS 中旧 127.0.0.1:5192 为 0，官方后端引用存在。

使用该包实际 DLL/Node22.22.2/WebView2 loader 的隔离 Smoke 窗口 **30/30** 通过，含包内服务启动、资源、bridge、页面渲染/无横向溢出、系统浏览器 loopback 交接及关窗/重开；仅复用旧 `Smoke.*` 宿主，KeepWindow=0，自己的测试窗口已关闭。Cloud 截图取得时仍为服务载入/价格待确认状态，不能作为真实价格、付费身份或已登录账户验收。没有操作普通 Program.Main、系统协议付款返回或安装器。实际包内运行时/模块专项 **55 通过/1 本机链接权限跳过/0 失败或取消**。Windows 当前导出源文件的 .NET 回归另为 **2 通过/1 Windows 符号链接权限跳过**；合成文件与来源 guard 测试不等于 WebView2 真实账号的 CSV/JSON 保存。

私有证据位于 `.tmp/windows-cloud/acceptance-resumed-83e7-{artifact-download,artifact-verification,packaged-modules}.json`、`resumed-83e7-ci-native-final/native-smoke.json` 和 `resumed-83e7-review-dotnet/cloud-export.trx`；包在 `resumed-83e7-ci-artifact-readback/`。完整托盘/单实例/子进程退出、普通 OAuth/付款 OS 返回、安装/升级/卸载、真实导出和账号/实例隔离仍按设备清单验收。下面 392/92 的“未下载、未运行”只描述当时，当前独立包检查以本节为准。

## 最新胶囊版审核包，39208a10

用户要求收紧月/年控件后，当前应用源码为 `39208a106b6861660c7bdda23b08878a21fa470d`，仍为未统一桌面发行的 1.3.2。[CI 38045978106](https://github.com/xiufengsun/TokenTracker/actions/runs/38045978106) 四个 job 与 CodeQL check 全部成功、0 新注释；Windows job 已正常构建前端、校验 review package manifest，并上传[最新审核包](https://github.com/xiufengsun/TokenTracker/actions/runs/38045978106/artifacts/11666764380)。该 artifact 元数据为 196,010,219 字节，官方 digest `ba154632dfca50a50c2756a6290476169c96f36215ea9b95f0e939585752aa98`，过期时间 2026-10-17 10:54:50 UTC。

本轮没有再次下载该完整 archive 或运行 Windows EXE，不能把下面 92 的整包/前端 hash 当新胶囊验收。两提交只有定价 JSX 与 CSS 变化，109 个 core 文件逐 Git blob 未变，旧 core 核验保留这一有限范围。Windows 实机继续使用这次的新审核包检查胶囊布局、侧栏标识和下方设备步骤；不能使用旧包代替。Mac 新 EmbeddedServer 已绑定 Git392、src106/dist259 匹配，包内胶囊模块/CSS HTTP200；这也不代称 Windows GUI。

## 初版 1.3.2 / 92d07c4e 包记录（历史）

应用源码 `92d07c4eb6ac685196f55b0ba0a14580bfb9e61c` 已正常推送，含侧栏 Pro 标识、卡内续费 switch 和精简结账流程。[CI 38041985678](https://github.com/xiufengsun/TokenTracker/actions/runs/38041985678) 四个 job 全成功，CodeQL check 成功、0 新注释。真实 Windows CI 的 Node24/包内 Node22 各 3869 通过、40 条件跳过，.NET 119 通过、1 项权限跳过，ZIP 和安装器编译通过。正式网页也是该源码，真实固定月付及全额退款已验收；银行/钱包和商户提现到账仍是独立事项。

[当前 Windows 审核包](https://github.com/xiufengsun/TokenTracker/actions/runs/38041985678/artifacts/11665609276) 已独立下载，196,009,467 字节，SHA256 `acb9be13ca9535f9daf741ae1617ed4f04dfb08823bdc2982e6cbba8b3fb53b8` 与官方 digest 相同。CI checkout a15381b9 与 Git92 的 tree 同为 f2724f7678f2b2b0188268e1682304ed43d077af；983 项 payload 大小/hash、109 项嵌入 core 源码匹配，manifest/package 1.3.2，EXE/DLL PE 版本 1.3.2.0。新 UI 和 44px 样式存在，旧 5192 配置出现次数为 0。ZIP 115,733,606 字节/SHA256 `4e74512452377f2fd26f063f3d4cf9898cbeac8f54ef5a54f529a656e6726c0f`，安装器 81,397,746 字节/SHA256 `d39e8b7fcc6722bc4579b7758129275bf4bce4bc883281b5f697043ea545eee0`。

这是下载、源码、资源和 PE 元数据验收，没有执行 EXE/安装器或新的 Windows GUI。实例与账号隔离、系统支付返回、Main/托盘、安装升级卸载、数据保留和 CSV/JSON 文件保存继续使用下方设备步骤；旧设备记录保留原来源。审核包在 GitHub 保留 7 天，本机私有副本与证据位于 `.tmp/rollout-20261010/pro-ux-windows/`。普通 App 不受本轮包核验影响，没有发布统一桌面版。

初次正式启用记录（2026-10-10），production source 为 `f51520eed4cf1238638e1d335bd0934db87638db`，相对 282 仅更新三个公开 HTML 说明文件，应用/原生源码不变。未税 USD4.99/月、USD39.99/年；live active 的原设备过渡期至 11 月 9 日 13:52:14（UTC+8），不能在设备测试时重置启动时间。当时真实付款/退款/结算尚未验收；其后固定月付和全额退款已验证，实际到账仍独立。本文的 282 包证据保留其精确来源，未冒充 f515 新包或实际 GUI 运行；网页启用不代替物理 Windows 步骤。最新部署与私有证据见 [发布总表](cloud-release-readiness.md)。

## 1.3.1 / 282ffa95 记录（历史）

源码 `282ffa95370a8c84a3911908079a46a38b70a88e` 已推送并独立读回。[CI 38024326226](https://github.com/xiufengsun/TokenTracker/actions/runs/38024326226) 四个 job 和 [CodeQL 38024326217](https://github.com/xiufengsun/TokenTracker/actions/runs/38024326217) 全部通过；真实Windows Node24/包内Node22各3869通过/40条件跳过，.NET119通过/1个符号链接权限跳过，完整应用、ZIP和安装器编译通过。c7生产WPF缺System.IO的[首次失败](https://github.com/xiufengsun/TokenTracker/actions/runs/38023611765/job/114129674138)保留，282补齐命名空间后已在真实Windows CI通过。UI/前端与c7 Git blobs一致，旧实机记录仍保留其原来源。

当前审核包来自 artifact **11660137708**，已下载核对 **196,010,118 字节/SHA256 bf51c875be85e84bd8d72aa0cf9cc14599ac5b61791c4c36825431d7e2f092b5**，与GitHub digest相同。实际checkout `6f0cca42309a41c438e1184676198c5c59d2677a` 的tree与282相同，**984个文件大小/hash、109个嵌入源码Git blob**全部匹配。ZIP **115,731,783 字节/SHA256 448ced01f706adf70bc45391281326ed9790ad2b88fbc71605707c3850457b01**；安装器 **81,400,200 字节/SHA256 5b547a5877e97e8d6d07f0dfee34d451bc5829c0c1a4c642dde3022df6b2766a**。本机可用4项私钥/管理key模式零命中，Windows保存的生产私钥未在本Mac获得，未声称覆盖。证据 `.tmp/rollout-20261010/native/windows-package-282-independent.json`。本轮没有执行Windows GUI或安装器；下载及编译不代替设备验收。

Mac QA第二轮文件保存的8事件/3文件全部通过，证据见总表；网页OAuth成功也不等于普通非QA原生OS返回通过。本轮仍需真实 Windows 设备证明 OS 返回 App、完整 Main/托盘、单实例/JobObject、安装/升级/卸载、个人数据保留，以及新增 CSV/JSON WebView2 文件保存。导出文件应来自本人当前后端、记录 UTC/估算 USD/实际日期范围；切换账号或实例后的晚结果不显示成功。新文件不能覆盖已有同名文件；正常导出使用 Downloads 的继承 ACL，不把它当 owner-only NTFS 私有码管理证明。此前工具拒绝的系统操作不换工具绕过。

Windows gift 管理员的原码生成/resume 仍为可选且 fail-closed，应用内兑换不受影响；可由已验证的 Mac/Linux 管理程序发码，不作为必须等 Windows 才能启用收费的门槛。官方后端继续使用现有付费 InsForge，不需要 Windows 服务器。工程准备当前源码的新包及 hash 后接续，下面包均保留其原始来源。

## 1.3.0 / 6abe2701 工程记录（历史）

[CI 37989219495](https://github.com/xiufengsun/TokenTracker/actions/runs/37989219495) 全部通过：Windows Node24/实际包内 Node22 各 **3858 通过/40 条件跳过/0 失败或取消**，.NET **117/117**，安装器编译与上传成功；macOS **3892/4 跳过及 239 原生**、Linux **3888/8 跳过**和 Rust 通过。CodeQL 门禁 **114019867015 success / 0 新注释**；通知文件竞态现已在 Mac/Linux 实际通过。该提交只更新交接与两个夹具，应用/构建/workflow 输入仍与 c93c9080 相同；实际 c93c9080 包内通知与同步锁组合专项另为 **67 通过/4 POSIX 跳过**。下方 984/109/30/55 的人工包验收保留其实际来源，不升级为新 archive 已人工验收。

完整 Program.Main/托盘、单实例/Job Object、OS 协议支付返回及安装/升级/卸载仍缺实机证据。最新预览、19 个后端候选与 Owner/工程门槛见 [总表](cloud-release-readiness.md)。本文随后仅更新交接，后续 head 检查按 [PR 当前 checks](https://github.com/xiufengsun/TokenTracker/pull/772/checks) 读取。

## 后续测试夹具：应用源码未变

7bd905d6 的 Windows Node24 全量为 3858 通过/40 跳过；包内 Node22 有 1 项 native account publication 夹具未处理 SYNC_BUSY，不能算完整通过。成功路径现观察两次真实 EEXIST 后才释放锁，立即处理 Promise 拒绝并使用受控时钟；独立超时拒绝仍用真实时限，原队列/token 断言均保留。Node22/Node24 本机相关文件各 **27/27**，无失败/取消/跳过；没有改产品行为或加大测试超时。后续完整结果读取 [PR 当前 checks](https://github.com/xiufengsun/TokenTracker/pull/772/checks)，来源细节见 [总表](cloud-release-readiness.md)。下方实际 c93c9080 包结果不冒充后续 head 的完整 CI。

后续 e9b06987 的 macOS env 通知夹具空标记失败保留；12 处标记写入已改为写完再原子 rename。本机 Node22/Node24 通知与锁组合各 67 通过/4 POSIX 跳过/0 失败或取消；没有用 Windows 条件跳过代替 Mac/Linux 的 env 验证，也没有修改产品通知逻辑。全量结果仍按上述当前 PR head 读取。

## 已核验应用与包来源：1.3.0 / c93c9080

应用与受审来源 **c93c908059a298a32855ee19a5741c048cf21899**。修复排行榜三个 catch 的错误输出，公开异常队列/隔离审计与受保护扫描总结失败现只返回操作固定的 HTTP500 错误，不返回内部数据库/多行细节或序列化未知异常。新增完整转译 handler 回归在旧源码实际 6 失败/1 通过；修复后相关目标组 **57/57**，两份变更 hash 和提交 blob 一致。实际 ESM 函数产物另有 **7/7**，53661 字节 / SHA256 129fa654ef8f0f21d0fa21456294f5e622b800c7d81d97fde2137766ec2c8c2e，仅以该源文件为输入，保留既有 npm SDK import；正式远端排行榜 handler **尚未部署**，仍按恢复与 preview 回归门槛部署。不能把本机产物通过写成远端已修复。

[CI 37982441711](https://github.com/xiufengsun/TokenTracker/actions/runs/37982441711) 四个 job 全通过：Windows Node24 和实际打包 Node22 均 **3898 项、3858 通过、40 条件跳过、无失败/取消**，.NET **117/117**；Linux Node **3888 通过/8 跳过**；macOS Node **3892 通过/4 跳过**及 **239 项原生测试**通过；Rust job 全通过。新七项 handler 回归实际在所有 Node 平台执行。证据 acceptance-edge-error-ci.json 与 job log；前一文档-only 96d4046b CI 被替代运行取消，不记为通过。

CodeQL 实际 PR check **113997145048 success / 0 新注释**；分析 1925873147 的 merge cb830f3016d3f8d41608fd9a2bc42e4e0bb5c5f3 tree 与该 head 相同。告警 222 在 PR 自动标为 fixed，没有人工 dismiss；主干原告警仍 open，不把修复升级为 main 已上线。之前的 16 条逐项人工判定及理由保留在 [安全审查](cloud-security-review.md)，本轮分支剩 **14 条主干已有 open**，未一并忽略/禁用查询。证据 acceptance-edge-error-gate.json。

该提交 Windows archive **195991432 字节 / SHA256 53ce5c37b9cd50615531ca3b61ce8de3535be9e7b9f97ef56e335e4f7d50fceb** 与 GitHub digest 相同；实际 checkout **cb830f3016d3f8d41608fd9a2bc42e4e0bb5c5f3** tree **5d4a77b2c554531b1a541dd6e4d6211d12c66c68** 与受审 head 一致。**984/984 文件大小/hash、109 份嵌入源码 Git blob** 全匹配；四项现有私钥/管理 key 字节模式零命中。ZIP **115721267 字节 / SHA256 10cd7648622b843f6d929be862f2d9eb9ee781376d3cb065ccbb84ebe9d44f28**；Inno **81392627 字节 / SHA256 e25430633226a2220f8167d0d5d1da9ad66fb04601a17b083b366c3416180def**。实际该包 DLL/EmbeddedServer **30/30 原生窗口**通过，实际打包 Node22 与包内模块 **55 通过/1 本机链接权限跳过/无失败或取消**；源码位置断言通过。旧 Smoke 宿主复用，应用 DLL/runtime/loader 来自新包；未操作已有用户安装。原生完整入口、OS 协议付款返回与安装/升级/卸载依然无本轮通过证据。

首轮 Windows Node22 为 3857 通过/40 跳过/0 断言失败/1 文件超时取消，init-local-runtime-reinstall.test.js 的连续复制超过 120 秒，后续安装器/上传未执行；不记为通过。相同文件在本机隔离 Node22 实际 3/3、21.88 秒；仅重跑失败 Windows job，成功结果见上。首轮完整日志与 acceptance-edge-error-ci-first-attempt.json 继续保留，未删测试/提高超时/改变受审源码。

最新 [Vercel Preview](https://dashboard-bdtmuqdm2-sunxiufeng1992-8555s-projects.vercel.app) 的 deployment **6969570061** 读回 success，来源精确为 c93c9080；账单、价格、条款和隐私四路由仍转到 Vercel Login，当前浏览器打开最新账单地址也相同。未改变访问保护，未记为应用验收通过；正常预览访问仍待 Owner。证据 acceptance-edge-error-preview.json。

UTC 20:00 正式后台再次只读核对仍 hosted/preview、launch_at=NULL，live 订单/支付/订阅全 0。已登录 Waffo 后台可见 1 个支付宝 CNY 提款账户；页面没有渠道验证状态标签，不能从账户存在推断已验证，也无需重复添加。API 的 channelStatus=unverified/channelVerifiedAt=NULL 与 Owner 先前报告仍分开记录；[官方流程](https://docs.waffo.ai/merchant/payout-accounts)说明新账户在首笔真实提款核对收款人后才标 Verified，因此当前字段可能反映尚无首笔提款，不单独证明配置错误。只保留脱敏事实，不复制页面身份或账户号码。证据 acceptance-release-live-state.json、acceptance-release-waffo-ui.json。未开启收费、会员限制、促销或归档；真实资金、首笔提款及到账、受保护前端、隔离恢复与原生生命周期门槛仍独立存在。后续受审源码改变须重新按来源记录，历史结果不自动升级。

## 前一已核验候选：1.3.0 / c3909232

应用与受审来源 **c3909232d416ff113aad417da892deafe1c50a84**。第二批改动使设备身份配置写入通过随机 wx/0600 临时文件原子替换；WorkBuddy trace 从同一打开的 descriptor 检查和读取；Bot 帧构建使用独立 mkdtemp 目录，只清理自己的文件；Windows 包清单大小/hash 从同一 buffer 获取；代理错误只返回限长首行或通用信息，不调用未知异常的 toString。Windows POSIX mode 不作为 NTFS ACL 证明。

本机实际 Node22 目标组 **414 通过/1 文件符号链接权限跳过/0 失败/0 取消**，12 文件、415 项、92.246 秒自然结束；十份源码/测试运行前后 hash 及提交 blob 一致。旧 Bot 临时文件与 WorkBuddy 路径替换均在同一新增回归中实际失败，修复后通过。证据 acceptance-windows-security-second-combined.json/log、acceptance-security-second-commit-binding.json 及两个 before 探针。

[CI 37980273730](https://github.com/xiufengsun/TokenTracker/actions/runs/37980273730) 四个 job 全通过：Windows Node24 与实际打包 Node22 均 **3891 项、3851 通过、40 条件跳过、0 失败/取消**，分别 206.348 秒/181.320 秒；.NET **117/117**。Linux Node **3881 通过/8 跳过**、macOS Node **3885 通过/4 跳过**及 **239 项原生测试**全通过，Rust job 全通过。新增文件链接替换、代理异常和 WorkBuddy 替换回归在 Windows CI 实际执行，文件链接回归在 macOS/Linux 亦执行通过。证据 acceptance-security-second-ci.json 与各 job log。

第二批五项源码告警自动关闭。完整 SARIF/源码与回归逐项核对后，5 条隔离测试告警以 used in tests、11 条预期且受约束的数据流以 false positive 标记，并逐条读回；未禁用查询或忽略目录。实际 PR 安全 check **113989824128 已为 success**，标题为 No new alerts in code changed by this pull request；历史注释计数仍 16，不能写成原始扫描零告警。分支仍有 **15 条主干已有 open**，未一并关闭；具体依据和剩余范围见 [逐项安全审查](cloud-security-review.md)，证据 acceptance-security-reviewed-adjudications.json、acceptance-security-second-gate.json。

该提交的 Windows archive **195991257 字节 / SHA256 4b1c5348409bee4d0f9614ba196e2e3b6a1b0a777912c2186df7dd462478b4fe** 与 GitHub digest 相同；实际 checkout **a9e0c1e6aaede654385fe88f1269f61537761712** 的 tree **65cd95e5a136a0fdca3dea4a105862d76f8a28c9** 与受审 head 一致。**984/984 文件大小/hash、109 份嵌入源码 Git blob** 全匹配；四项现有私钥/管理 key 字节模式零命中。ZIP **115721260 字节 / SHA256 dd1a078431508ce709799d578cebc3896e26f7d4a27fea3830d8c2362f330766**；Inno **81392446 字节 / SHA256 1647ad975e4548fec1228134b2f75188a65b48df295c023c496c4b8b19ecbe2b**。

实际该包的 DLL/EmbeddedServer **30/30 原生窗口检查**通过；实际打包 Node22.22.2 和包内 OpenClaw/Unicode 技能复制/原子 JSON/Bearer/代理/WorkBuddy 模块 **55 通过、1 本机链接权限跳过、无失败/取消**。测试只复用 Smoke 宿主，应用 DLL/运行时/loader 来自新包，来源断言通过；未操作已有用户安装。证据 security-second-ci-native-final/native-smoke.json、acceptance-security-second-packaged-modules.json 和合并 checkpoint。不是完整 Program.Main/托盘、单实例/Job Object、OS 协议付款返回或安装/升级/卸载证明。

最近 fetch：main **e6186b35**、功能分支 **c3909232** 均无外部新增提交，主干已为当前分支祖先；PR MERGEABLE/CLEAN，保持 draft。UTC 19:32 正式后台只读核对仍 hosted/preview、launch_at=NULL、live 订单/支付/订阅均 0；Waffo 商户 active、payoutEnable=true、绑定匹配，但 channelStatus=unverified/channelVerifiedAt=NULL。没有开启收费、会员限制、促销或归档。当前工程与 Owner 门槛继续以本文后续表格为准。

## 第一批安全修复记录：后续门禁与包结果见上述候选

第一批已修复 Bearer 前缀解析的重叠正则、静态文件检查/读取竞态，以及 gift admin 的私有凭据与 resume 文件校验/读取竞态。Windows 私有文件入口仍按原 ACL 门槛关闭。支付测试 URL 条件改为精确 origin 判断。

对应 Windows Node22 目标回归 89 通过/7 条件跳过、无失败或取消，九份变更与提交 blob 一致。旧静态服务器替换回归实际失败；旧 Bearer 表达式对长空格加两个换行的畸形值在隔离进程超出 1.5 秒预算，修复后完成。纯空格值未复现超时，Node HTTP parser 本身拒绝含换行的 header，未声称已经证实可远程利用的 HTTP 攻击。证据 acceptance-windows-security-final-fixes.json/log、acceptance-security-before-fixes.json；其后完整跨平台 CI 结果见上。

2026-10-10（Asia/Shanghai）更新。上一已核验应用候选为 **1.3.0 / 896baa52**，修复 Node22 中文目录递归复制的原生崩溃；实际 Node22 完整本机回归已通过：363 文件、3830 通过、0 失败、0 取消、47 条件跳过。最新受审 head 29b02f5a 的四平台 CI、新包核对、30 项原生窗口及 18 项包内专项已通过；CodeQL workflow 成功，但 PR 安全门禁有 27 条注释需工程审查/修复。前一 60b8935b 的 CI/982 文件候选包/107 嵌入源码核对及 30 项原生窗口检查仅证明旧源码。正常邮箱登录与换账号证据亦保留原始来源。完整托盘、系统协议付款返回和安装器生命周期仍待验收。

这里需要的是 Windows 客户端测试电脑。官方后端仍使用现有付费 InsForge，付款由 Waffo 处理，不需要 Windows 服务器。

本轮已在原 Windows 工作区重新拉取功能分支。当前源码和本机回归统一记录在 [上线前交接总表](cloud-release-readiness.md)。下文按来源保留 Mac 交叉包和 10 月 8 日实机记录；这些包都不是后续合入主干后源码的正式发行产物。

## 1.3.0 阶段 Windows 接续证据（历史）

896baa52：安装包中的 Node22.22.2 补查暴露 native recursive copy 的 Unicode 路径退出码 3221226505。已用隔离目录复现，技能导入/链接 fallback 的 fs.cpSync 在 Windows 使用恒真 filter 保留全部条目并选择 JS 遍历，同步安全 guard 不变。新增子进程测试复制中文用户目录和 UTF-8 嵌套文件，并强制链接 EPERM 验证真实复制；TRAE trim fixture 保留真实完整运行库检查。

实际 Node22 的完整本机回归在 188 秒自然结束：3877 项、3830 通过、0 失败、0 取消、47 跳过；四项 profile 与子进程 Node PATH 隔离，四份变更文件在运行中及提交绑定一致。证据 acceptance-windows-node22-copy-full-fixed.json/log、acceptance-node22-copy-commit-binding.json；此前 Node22 的单文件崩溃保留在 acceptance-windows-packaged-node22-full.json/log。Node22 专项 62 通过/6 跳过，Node24 专项 74 通过/6 跳过，无失败或取消。最新受审 head 为 29b02f5a，应用源码仍为 896baa52；CI 37973812448 四个 job 均通过，Windows Node24 与实际包内 Node22 全量均 3840 通过/37 跳过/0 失败/0 取消，.NET 117/117。CodeQL workflow 成功，但安全门禁并未通过，见总表。

受审 head **29b02f5a9960cdb0b16cfb2d5215ad1c9f4336c1** 的 Windows 产物已独立下载核验：archive 195992529 字节、SHA256 7af2e4e1a6e81d809536a9c138edb92caa19093384c0a2ad5a767f8ca4bdd48f，与 GitHub digest 相同；checkout a4e489556b14aaa67a32dceb46d67fc71a92eb33 的 tree 275f67f25cbe7d2d81cba5fbebeea85b31060851 与受审 head 一致。982/982 文件大小/hash、107 份嵌入源码 Git blob 全匹配；四项现有私钥/管理 key 字节模式零命中。ZIP 115719886 字节、SHA256 a33757e232db0499cfb03792805a58f5d09ba6b164694c75174220d164c79e80；Inno 81394638 字节、SHA256 692c733aae89b33f3a0b0e96dff8dd8e938cf64ea63489508ed595eea51c5082。

实际新 CI DLL/EmbeddedServer 的 30 项原生窗口检查通过，node22-copy-ci-native-final/native-smoke.json；实际包内 Node22.22.2/OpenClaw/中文技能复制另有 18/18，acceptance-node22-copy-packaged-modules.json。前两次宿主构造失败（多复制 CLR host 文件影响 framework 查找；Smoke deps 预解析 harness 内 DLL）均保留失败记录；最终只复用 Smoke 测试宿主并移除其应用 deps 绑定，发布 DLL、WebView2 loader 与 EmbeddedServer 全部来自新包，源码位置断言通过。没有操作已有用户安装；不是完整 Program.Main/单实例/Job Object、OS 协议支付返回或安装/升级/卸载证明。

CodeQL 的 workflow 37973812430 执行成功，但 PR 的 CodeQL 安全门禁 113968044957 失败，报 27 条新注释（13 high、14 medium）；分支总计 42 条 open，主干 23 条 open，按告警编号比较有 21 条仅在分支存在。扫描流程成功不等于安全验收通过，注释数量也不等于已经确认的可利用漏洞。原始注释、分支/主干比较私有保存；工程继续逐项判定和修复，不能把 Owner 登录或资金门槛当作这部分工程工作的替代。

以下 60b8935b 是前一阶段。

60b8935b 修复 OpenClaw npm 的 Windows .cmd 启动问题：读取 PATH 对应 npm 包声明的 JS bin，用当前 Node 直接运行，保持中文/空格/&/% 路径和特殊参数，不启动 cmd shell。hook/session plugin 共用启动逻辑，启动失败、超时及信号退出不会误报成功；53 项相关回归通过。完整回归 3876 项、3829 通过、47 跳过、无失败或取消，184 秒自然结束。运行中源码 hash 保持，并在提交前逐文件核对；acceptance-windows-release-full.json/log 与提交绑定记录提供来源。

Windows CI 改为构建 Dashboard 后运行完整 Node 测试，并校验官方 SQLite 测试工具大小与 SHA3-256；不修改产品或系统 PATH。47 项本机跳过保留原因，新增平台限制仅用于 Unix nvm/procfs、POSIX env/shebang 和 Linux Bash 包装夹具，Linux/macOS 继续执行。Windows 原生进程/端口和 Node 通知链仍测，目录链接用 junction 实测。POSIX mode 不是 NTFS ACL 证明，本地扩展路径的 UNC 前缀覆盖不等于 WSL 挂载证明。最新 CI 37970035795 四个 job / CodeQL 37970035738 全部通过；Windows CI Node 3839 通过、37 跳过、无失败或取消，本机额外十个符号链接用例在 CI 通过。macOS Node 3870/4 跳过，Linux Node 3866/8 跳过，均无失败；Windows .NET 117/117。

60b8935b 产物的 archive SHA256 c24b1da9e8f461a0082dc58fe3c8a47d5f7415e14fea8b5506e04558e7685a80 与 GitHub digest 相同；实际 checkout f828941f2f934887d08153402a60d4ebcd8d7e5b 的 tree 649e60a7dca5380593263e2d90031c7aa85f49b2 与受审 head 一致。982/982 文件大小/hash 和 107 个嵌入源码 blob 匹配，四项私钥/管理 key 字节模式零命中。ZIP SHA256 bfd3dcc267e60841fac380c67de56dd2378ea67fde3a0565f902524020cc7012，Inno SHA256 9a2622e808153a1ae240b8f7abc864a3b6816dfaba9f387dd97b6e27c32366c4。实际新 CI DLL 与 EmbeddedServer 的 30 项原生窗口检查通过，release-ci-native/native-smoke.json；实际打包 Node22.22.2/包内 OpenClaw 模块另有 17/17，acceptance-release-packaged-openclaw.json。Node24 全量与 Node22 专项范围分开，未称 Node22 全量通过。详细大小与原始证据见总表；以下 b0a6544d 及旧记录仅证明各自源码，安装器生命周期和完整 Program.Main/协议付款返回仍未执行。

后续排障修复了 TypeScript 检查启动 npm.cmd 的 EINVAL、Markdown 索引路径使用 Windows 反斜杠，以及 Ark timeout fixture 将所有 where 查询都错误映射至 arkcli.exe 的卡住。前两组 11/11、Ark 专项通过，Node24 全仓随后在 172 秒自然结束：3764 通过、67 失败、0 取消、38 跳过，未触发测试文件超时；不是全绿。进一步修复 Roo/Kilo 自定义目录列表拆开 Windows 盘符的问题，使用系统 path.delimiter；真实目录扫描和两次解析去重/backfill 14/14 通过。新的 CI 已覆盖这些检查。该 src 改动发生在下文 8497d6e9 包之后，旧包不能代替新候选的打包验收。

b0a6544d 的 CI 37965509474 四项及 CodeQL 37965509485 全部通过。精确 head 的隔离全仓 Node24 回归自然结束：3770 通过、61 失败、0 取消、38 跳过，168 秒，无文件超时，acceptance-windows-after-drive-fix.json/log；仍不是全绿。新 CI 包已独立下载验证：archive SHA256 4e9e35e9abd18b817c3d53c97dc45fd4ed156a614d3f9c22ec8f281f3316b06c 与 GitHub digest 一致，checkout 7fed619a2dbadde08353923ec62128adcb1cb10f 的 Git tree 与 head 一致，981/981 文件和 106 个嵌入源码 blob 均匹配。ZIP SHA256 cb394f582aee5726b89c45eb983f2815f9218ae55cb701368eefbc7a75166bb3，安装器 SHA256 424b9e3fd37b7e0b46cd05bd69d43059320f99fccac8b24791ca5c6e641a362f。当前四项私钥/管理 key 字节模式零命中；旧 QA 凭据已清除，未把上一轮十项扫描数量沿用到新包。新 CI DLL 与打包 Node 的 30/30 原生窗口检查通过，证据 triage-ci-native/native-smoke.json；完整托盘、协议付款返回及安装器生命周期仍待验证。

1c96a2cc 的 CI 37956050272 四个 job 全部通过，Windows .NET 117 项及完整 ZIP/Inno 安装器构建成功；CodeQL 全通过、开放告警为 0。Dashboard 当前 1192/1192 通过。旧全仓 Windows Node 快照为 3728 通过、80 失败、20 取消、38 跳过；新的 Node22 隔离对照为 3738 通过、70 失败、20 取消、38 跳过，最新 e6186b35 主干亦有 93 失败。具体匹配边界见总表，不能以目标组或 Linux/macOS 全绿替代。新增同步专项的三项失败来自真实 AppData 混入 fixture；隔离 APPDATA/LOCALAPPDATA 后 27/27，已加入 Windows CI。

原生测试宿主加载发布目录 DLL，并使用隔离 WebView2/应用数据。最初宿主输出目录缺少 EmbeddedServer，使应用的开发 fallback 使用系统 Node16，auth proxy 返回 502；该次不能算嵌入 Node 登录证明。补齐宿主的打包资源后，普通邮箱登录真实 InsForge 测试账号成功、Pro 年付 US$39.99/月付 US$4.99 显示正确、固定期切换正确，试用/付款在 preview 禁用。系统浏览器 loopback、安全 URL 拒绝、窗口隐藏/重开均已执行；不是完整 Program.Main 托盘或 OS 深链返回证明。

当前干净 1.3.0 发布目录通过 34/34 原生检查，并显式断言使用打包 Node。普通 UI 的登录 B、重载保持、退出后重载清除及切换 A 共 7/7 通过，身份使用实际账户页的邮箱/UUID核对。A/B 专用账号随后已删除并验证旧密码被拒绝；原有用户和安装数据不变。

私有证据位于 .tmp/windows-cloud/acceptance-rc-clean/、acceptance-native-ui-rc.json、acceptance-qa-cleanup.json、acceptance-auth-gifts.json（16 项真实 API）、acceptance-live-preview.json（8 项正式 preview API）。这些 API 测试不等于成功 Windows 赠送 GUI 或真实资金验收。

CI 51bdcdfd 的完整 review artifact 已下载并验证 GitHub archive digest，ZIP 独立解压 981/981 文件大小与 SHA256 一致。实际 workflow checkout 为 merge SHA 042850b2，其 tree 与 review head 51bdcdfd 相同；该旧包版本 1.2.2。1.3.0 的本地干净包已验证 379 个输入、981 文件；CI 已生成新版 ZIP/安装器。最终 artifact 已完成独立下载核对；来源与完整 hash 如下，不沿用旧包 hash。

最终源码 8497d6e998369a8d4c90b2901ec089ed5dd7930a 的 CI artifact 已独立下载：archive 195981496 字节、SHA256 241d97ae378869532f172976b4662104696648b3af73e3410de4979cb80dc6c8，与 GitHub digest 一致。实际 checkout 为 7fd5fbfb86e6dda495fb773a8e09465a8eb0198d，Git tree 与受审 head 相同。1.3.0 ZIP 115718586 字节、SHA256 c3fab9a59fbe318c9d016897d1db7d712bceb53daba5ce1fa75bac64e9323fd4；Inno 安装器 81384336 字节、SHA256 0f898ddd528997710ce6684757b471b6caab81d8fbc3d02d1a520003a30edd30。解压 981/981 文件大小与 hash 一致，106 个嵌入 CLI/入口/清单源文件与 Git blob 一致，10 项实际私钥/管理 key/已撤销 QA 凭据的逐字节扫描命中为 0。安装器尚未执行安装/升级/卸载。

最终 CI DLL 与打包 Node 已执行 30/30 原生检查，证据为 final-ci-native/native-smoke.json。首轮仅复制宿主顶层文件而缺少 WebView2Loader.dll，导致窗口初始化失败；CI 包含此 loader，补齐宿主的 CI loader 后通过，失败记录保留为 native-loader-fixture-failure.json。此次不是 Program.Main、深链付款返回或安装器生命周期测试。旧混用目录包含残留前端 hash 文件，校验器已拒绝，该目录不能作发行包。

本机安装 Inno 的动作被自动审批审核拒绝，仅返回 blocked by policy，未执行；CI 使用预装编译器的构建已通过。完整托盘测试和工具拒绝的协议点击仍保持待设备验收，不用其他工具绕过。已有个人安装、注册表和历史数据保留。

## 2026-10-09 Mac 赠送码交接（历史）

2026-10-09赠送码更新。代码`77ca20241d0f6d0830acdbbb720e3bf078591dc2`已加入账户兑换、领取记录、重复领取保护及赠送期的结账提示。新的自包含测试包为`.tmp/waffo/hosted/native/gift-refresh/TokenTracker-private-pro-gifts-win-x64.zip`，111615167字节、975个文件，SHA256为`27eceecbbf794caf1cbaf4a60f92bae3ad6cecec341ff7bebacf593476194eed`。877个相关Git源码blob与构建输入一致；独立解压与私有凭据扫描通过。版本仍1.1.13，包不作为正式Release发布。

Windows实机接续时，除下文登录、付款返回和安装器步骤外，补充正常登录后兑换、重复输入、刷新、退出切换账号和撤回后的显示检查。测试路由须由工程侧准备；普通包直接打开不会自动接专用沙盒。macOS/Linux私有管理命令已验证，Windows的NTFS私有ACL未验证，原码生成和断线恢复暂时关闭，应用内兑换不受影响。本轮真实网页验证使用Mac上的Ego Browser，已审查390px/1280px浅深色视口截图；两个真实账号退出HTTP200，服务端会话清除且重载仍未登录。该 Mac 阶段没有新增 Windows GUI 证据；当前 Windows 登录/退出/切换证据见上文，成功礼遇兑换尚未证明。

## 2026-10-09 Mac 接续记录（赠送码之前）

Windows端工作结束后，Mac已快进整合`e40f47f4`，继续修复本地认证及支付返回。新普通Windows入口仅接受`tokentracker://billing/return?order=<canonical UUID>`，导航到当前本地后端的结账查询页；不从链接授予权益或指定账号/环境。正常OAuth回调保持，导航、history和入口日志不再输出完整URL/code。

这6个Windows文件经独立review；官方.NET8.0.425在Mac ARM64执行117/117单测，Release/win-x64交叉编译零警告、零错误。该结果没有新的Windows GUI或OS协议导航证明，下文63项实机单测及窗口证据仍绑定旧源码。当时前端1129项与后端3818项通过、2项跳过，均为Mac验证。本轮Windows117单测与合入主干后的1190前端结果见总表。

既有InsForge已增加独立的真实QA网关和HTTPS返回页，身份仍由真实InsForge签发；详见[原生沙盒手册](native-sandbox-gateway-runbook.md)。普通包不自动连接QA网关，也不携带沙盒密码、JWT、刷新token或Waffo私钥。另一台电脑从功能分支重新构建；当前Mac本地测试包仅作交叉打包证据。

当时的交叉测试包为`.tmp/waffo/hosted/native/TokenTracker-current-private-cloud-win-x64.zip`，来源代码`60780e40863ca20416641b0c14f9a1151ac2e507`。大小111609766字节，SHA256为`1a36e7a9cc2838ae341d2f980ab3e3b9f9536544268da3707e4d33ea054aa8ba`。975个文件独立解压后逐字节和SHA一致；102份CLI、1份入口、274份Windows网页与各自产物集合相同，609份相关源码与该commit的Git blob一致。这份包早于上文赠送码包。

Windows网页按现有发布流程以`TOKENTRACKER_BUILD_PET=1`独立构建，包含`index.html`、`pet.html`、`quota.html`和全部法律页面。未复用Mac无宠物入口的网页产物。使用官方Node22.22.2已校验缓存和.NET8.0.425自包含发布，运行时8.0.31。没有执行Windows、安装器或协议导航；这份包替代下文旧ZIP作为本轮工程测试包，源码与包核对不能代替设备验收。

## 2026-10-08 Windows 本机记录（历史）

构建验收的源码为 `8e45d91e43456d841b02002532cc6135e4a0a84d`，随后已快进至 `df051a64b230836bbc6bc69d1275d8f22dd6ee22`；远端新增提交仅更新三份交接文档，应用源码与测试包保持一致。本轮修改仅涉及 Git 换行约定、构建校验脚本、测试及验收文档；应用版本仍为 1.1.13，没有发布或启用生产收费。

环境：Windows 11 专业版 10.0.22000、官方 .NET SDK 8.0.425、Windows Node 22.22.2（官方 SHA256 校验通过）、WebView2 Runtime 120.0.2210.133、WebView2 SDK 1.0.4258.31。系统浏览器交接请求的 UA 为 Chrome 154。

| 项目 | 本机结果 |
| --- | --- |
| 自包含发布 | `dotnet publish -c Release -r win-x64 --self-contained true` 成功 |
| 原生单测 | 63/63 通过，TRX 保存在本地证据目录 |
| 前端全量 | 135 个文件、1120/1120 通过 |
| Cloud / 自部署 / 同步 / Windows 目标组 | 456 项通过、1 项跳过、0 失败 |
| 校验及类型检查 | copy、locale、UI hardcode、guardrails、versions、bot frames、Dashboard typecheck 均通过；架构及 bot parity 共 13 项通过 |
| 函数构建 | 18 个 Cloud 函数、14 个自部署函数在 Windows 构建成功；未部署 |
| 发布 DLL 原生集成测试 | 29 项通过。通过 WPF 调用本次 `publish/TokenTracker.dll` 的真实 `ServerManager` 和 `DashboardWindow`，不是浏览器中模拟 native bridge |
| 嵌入运行时 | 实际 Windows Node 启动本地动态端口；首页、runtime config、pet、quota、pricing、terms、privacy 均 HTTP 200 |
| WebView2 | 本地用量、Pro、自部署、设置、结账页面实际渲染并保存截图；无整页横向溢出；关闭后隐藏，重新打开复用原 WebView2 |
| 系统浏览器 | `openURL` 消息触发系统浏览器访问临时 loopback 测试页，实际收到 HTTP 请求；带用户名密码的 URL 未到达测试端点。没有创建支付订单 |
| 嵌入源码一致性 | 105 个 CLI/入口/依赖清单文件、275 个 Dashboard 产物与本机源文件逐字节一致 |
| Portable ZIP | 独立解压，982/982 文件 SHA256 一致；115695913 字节 |

测试使用独立的 CLI 数据和 WebView2 profile。调用系统浏览器时使用已有浏览器配置，避免隔离 AppData 触发浏览器首次启动；没有登录或提交付款。窗口集成测试结束后停止其本地服务。

本机测试包为 `.tmp/windows-cloud/TokenTracker-cloud-subscriptions-win-x64.zip`，SHA256：`4f5e2217f9cce06813a9be7a9ed29d3db0d19d0007a0971eed74fc341b6fc905`。构建和验证证据统一保存在 `.tmp/windows-cloud/`：`native-smoke.json`、`native-*.png`、`embedded-parity.json`、`package-verification.json`、`dashboard-verified.log`、`cloud-verified.log`、`test-results/windows-native.trx`。原生集成测试的本地工程保存在 `smoke/`。

### 本轮修复

- 新增 `.gitattributes`，文本检出统一为 LF，保留 Windows command 脚本的 CRLF 和 Inno 翻译文件原始字节。原 `core.autocrlf=true` 会使 SQL 函数重写报 `Account pricing SQL shape drift`，也会使按 LF 匹配的源码校验失败。规范化后应用源码 Git blob 没有变化。
- 帧生成校验使用 esbuild API，避免 Windows 上直接执行不存在的 `node_modules/.bin/esbuild`。
- 英文结账测试固定英文数字格式，避免中文 Windows 默认输出 `US$` 而使 `$` 断言失败；未改变产品中的货币格式。
- POSIX `0600` mode 断言仅在支持该语义的平台执行，Windows 的合成 mode bits 不能证明 NTFS ACL。checkpoint 的生产写入逻辑没有改变。
- 空队列迁移用例限定为隔离 Codex 来源，避免扫描真实 AppData 历史；榜单双向切换用例保留完整 userEvent 校验并给予 15 秒预算，解决 Windows 负载下的 5 秒超时。

### 本轮边界与待验收

- 一次全仓 Windows 复测为 3656 通过、83 失败、20 取消、34 跳过，**全仓未全绿**。该快照早于最后的空队列测试修复；其后的完整目标组已通过。Ark / Claude Science / WSL 相关的 10 项失败在独立 `origin/main` 快照中同样复现（49 通过、10 失败），不能据此认定其他失败全部为既有问题。完整输出为 `full-fixed.log`，基线输出为 `main-baseline-tests.log`。
- 公开正式账单路由的无登录探测返回 HTTP 404；结账页实际显示“服务可用前不能付款”。普通包仍走正式路由，当前没有本机可用的专用沙盒账号及重新配置的供应商返回通道。真实 OAuth 登录、换账号、付款拒绝/重试/成功、退款后状态及支付返回恢复未完成。
- 没有执行 Inno Setup 安装、升级或卸载。本轮 ZIP 校验不能代替安装器验收。
- 完整托盘程序启动、单实例与 Job Object 清理的额外验证步骤被自动审批审核拒绝，返回 `blocked by policy`，未提供更详细原因，该步骤没有执行。原生窗口集成测试不覆盖 `Program.Main` 的协议注册和完整托盘入口。

## 之前的交叉编译 checkpoint

| 项目 | 证据 |
| --- | --- |
| 编译 | 官方 .NET SDK 8.0.425，符合 CI 的 `8.0.x`；Release/win-x64，0 warnings、0 errors |
| 单测 | 上轮 63/63 通过；本轮原生源码未变，未重复运行 |
| 发布 | `dotnet publish -r win-x64 --self-contained true` 退出码 0 |
| 嵌入运行时 | Windows Node 22.22.2 的官方 SHA256 再次校验通过；102 个 CLI 源文件、1 个入口、273 个 Windows Dashboard 文件及两份依赖清单逐文件一致 |
| Portable ZIP | 112272521 字节，独立解压 974/974 文件大小与 SHA256 一致 |

当前本地包位于 `.tmp/waffo/hosted/native/head-fb792a53/TokenTracker-private-pro-win-x64.zip`。完整证据以 `.tmp/waffo/hosted/native/` 为根目录，包含 `native-acceptance.json` 和 `head-fb792a53/` 内的 `windows-publish-parity.json`、`windows-zip-readback.json`、`source-head-binding.json`。

ZIP SHA256 为 `c09b7b269effc413f40aec59e352df219f0f59f505a17b5aa7c30793b36932f5`。源码来自已推送的 `feat/cloud-subscriptions` commit `fb792a531139e5e3578a04da1748e0ce97df5890`。872 个相关受控文件与该 commit 的 Git blob 一致，构建完成后再次读回无变化。版本号 1.1.13 不能单独证明包包含本轮改动；以来源 commit、包 hash 和构建证据为准。CLI 或 Dashboard 改动后须重新构建核对。

当前 ZIP 已包含 InsForge 的 40/64 位 opaque 匿名公钥兼容性、Pro 头像与标识、中性灰榜单高亮及分页置顶会员标识修复，也包含新主干的 `pricing.html`、`terms.html`、`privacy.html`、`legal.css` 和 LegalLinks 入口。旧 `TokenTracker-private-cloud-win-x64.zip` 及 `pro-refresh/` 内的 checkpoint 包均早于完整主干整合，不能作为本轮测试包。以上证明包含打包与源码一致性；Windows Node、WebView2 窗口及支付返回仍待实机验证。

## Windows 剩余工程步骤

1. 使用专用 Windows 测试账户和临时 TokenTracker 数据目录，保留用户原有安装、配置与本地历史。先读回包 hash，再准备 WebView2 运行环境。
2. 工程侧准备真实应用测试账号、白名单、沙盒 API 路由与付款返回地址。当前测试函数使用 `-sandbox` 后缀，普通发行包仍使用正式路由，直接打开 ZIP 不等于已接好沙盒。Mac 的 5195/5196/5205 操作器地址也不能直接照搬到 Windows。
3. 核对运行时配置与实际请求地址。公钥可进入客户端，服务端密钥、Waffo 私钥和当前测试账号的密码/JWT 不能打包或通过文件搬运。
4. 实测 WebView2 打开系统浏览器收银台、拒付重试、成功付款、关掉返回页及重新聚焦客户端。确认原订单页通过轮询、focus/visibility 恢复会员状态，且不会重复购买。
5. 实测免费本地功能、社区上传、会员同步、暂停恢复、到期或后端离线，以及退出登录和换账号。核对本地队列及旧账号数据不丢失、不混入另一账号。
6. 正式 Windows 安装器发布前，在专用测试账户执行 PowerShell bundling 和 Inno Setup，检查干净安装、覆盖升级、卸载与用户数据保留，以及协议注册、单实例和子进程退出。当前 ZIP、发布 DLL 和交叉编译证据不能代替这些步骤。

每条记录 Windows/WebView2/Node 版本、实际 HTTP 状态与请求目的地、服务端账本或权限读回和关键截图。禁止用“编译通过”代替窗口或付款返回验证。

## 接续入口

在另一台电脑上使用已推送的 `feat/cloud-subscriptions` 分支及工程新提供的包 hash 接续。下文旧包 hash 仅用于对应历史来源。不要从 `main` 的普通发行包推断已包含本轮 Pro 代码。本地 ZIP 未作为正式 Release 发布，可由工程侧转交并校验，或在 Windows 从该分支重新构建。

继续读取 [发布交接总表](cloud-release-readiness.md)、[交付清单](cloud-delivery.md) 和 [收款运维手册](cloud-billing-operations.md)。用户已授权提交和推送 `feat/cloud-subscriptions`，由主任务统一执行；现有 [PR #772](https://github.com/xiufengsun/TokenTracker/pull/772) 保持 draft、未合并。正式价格、完整网页和生产购买已按本次授权启用，商户审核、正式凭据/产品/webhook 和 14 个正式 handler 替换已完成。真实资金/结算、物理设备验收、统一桌面发行及公告仍独立交接，不再要求重复启用。
