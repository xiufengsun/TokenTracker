# TokenTracker Cloud 发布与验收交接总表

## 1.3.3 TokenTracker Cloud 已公开发布（当前）

Owner 明确授权公开发布，并选择 TokenTracker Cloud（云服务）。[PR #772](https://github.com/xiufengsun/TokenTracker/pull/772) 已合入 main，发行源码/tag 精确为 `cc934784e52ea88ef63030f63c59e1fcaedc38ce`。北京时间 2026-10-11 00:28:13，[统一发行 38067338204](https://github.com/xiufengsun/TokenTracker/actions/runs/38067338204) 全部五个 job 成功，六项资产与 SHA256SUMS 已公开，GitHub latest 为 [v1.3.3](https://github.com/xiufengsun/TokenTracker/releases/tag/v1.3.3)；旧 v1.3.2 tag/草稿保留为历史候选，未移动。

发行源码的 [main CI 38066628435](https://github.com/xiufengsun/TokenTracker/actions/runs/38066628435) 四个 job 全通过，CodeQL workflow 38066628411 成功。npm [38067305112](https://github.com/xiufengsun/TokenTracker/actions/runs/38067305112) 已发布 tokentracker-cli@1.3.3，注册表 latest/gitHead 和实际下载 tarball 完整性匹配，包内 Cloud 与政策文案通过；Homebrew Formula 和 Cask 已自动更新并分别匹配 npm tarball 与 DMG hash，未手工修改 tap。

发行时回读的正式网站 deployment 6983437661 成功，source 为 cc934784：五路由 HTTP200，价格/条款/隐私三份 HTML 与 tracked source 字节一致，实际加载的 Cloud 文案资源 hash 为 `35c25a558c2c4a31a3ab6ba6019a9ef56cf393e156413684f646fe352b18dce7`。中英文、390/1280px、深浅色页面无横向溢出。四个正式 Waffo 商品已改名，签名回读确认 ID、价格、税类、周期和 metadata 未变；没有新增订单或扣款，原 launch_at 和过渡期限未重置。命名与免费/付费边界见[定位说明](cloud-branding-and-positioning.md)。

Windows 两个发行文件已独立下载并匹配 GitHub digest 与 SHA256SUMS；解包 983 文件、109 个嵌入源码 Git blob 匹配。现有四项密钥模式零命中；EXE/DLL 为 1.3.3.0 / 1.3.3+cc934784e52ea88ef63030f63c59e1fcaedc38ce，Node v22.22.2。这些是静态来源、版本、密钥模式与下载字节核对，安装器没有在本机执行，不能代称完整 Windows 人工验收。

| 发行资产 | 字节 | SHA256 |
| --- | --- | --- |
| TokenTrackerBar.dmg | 62899436 | `432293f64802e9f7f83c5c8c5a89523b020049ca0cba32e925f257e6e15d033d` |
| TokenTracker-win-x64.zip | 115735469 | `9e1a26e21a3830eb10e6dfceef4aff67670c71dcf439bec22660e05ab12f13a6` |
| TokenTracker-Setup.exe | 81402216 | `7065584fa28e12cc3287583312dc87873b164c6b659279c65a12e70001aaa2bd` |
| TokenTracker-linux-x86_64.AppImage | 129481208 | `6d06bc2312929733f156c020f49ebaa7afc6ae45417f611d5190333e9f02399a` |
| TokenTracker-linux-x86_64.deb | 59266094 | `323b4880d66fae85c29d7f04982ae191ce1a38528ffe7b17bc435a04b0f8c33d` |
| TokenTracker-linux-x86_64.rpm | 59256139 | `4478c32952a87e137354145044401735a702ad22056a397efa393ed0dec79f57` |

剩余范围：Windows 人工安装/升级/卸载、登录、托盘/单实例/进程退出、系统 OAuth/付款返回、真实 CSV/JSON 保存仍需专用设备验收；年度固定期与月/年自动续费真实收费/续扣/取消/重试证据按 Owner“先不新增扣款”要求暂缓；退款实际到银行/钱包和首次商户结算仍需收据。Owner 已确认结算/提现账户已验证可用，旧 API 状态快照不自动否定当前账户设置。归档/删除任务继续关闭。社区公告仍是待指定渠道的草稿。

私有证据：cloud-133-public-release-verification.json、cloud-133-npm-verification.json、cloud-133-production-verification.json、cloud-133-production-visual.json、cloud-133-homebrew-verification.json、waffo-cloud-brand-verification.json。均位于 .tmp/windows-cloud/，不提交凭据或原始交易信息。

以下记录保留各自当时的版本、Pro 名称与验收范围；不能拿旧包或旧 QA 结果证明新包完整人工验收。

## 1.3.2 统一发行候选已备齐，公开发行仍待验收

[统一发行准备 38062816928](https://github.com/xiufengsun/TokenTracker/actions/runs/38062816928) 全部五个 job 成功，源码/tag 固定在 `a1f02b0889cecde6b0b7490ef8d5f086b996acb2`。六项资产的实际下载/hash 计算已由最终 workflow 执行；本机另下载 `SHA256SUMS` 并核对其 digest、六行与六项 GitHub asset digest 一致，Windows 两个文件实际下载字节/hash 再独立匹配。公开草稿与 Homebrew 两个步骤均 skipped，release `409024644` 仍 isDraft=true，公开 latest 仍 v1.2.2；main、npm 和公告尚未发布。

| 资产 | 字节 | SHA256 |
| --- | --- | --- |
| TokenTrackerBar.dmg | 62900012 | `0773f0b51d7139b1326a6915436b97e072a934f63304c4a57bf315c69ec05c6f` |
| TokenTracker-win-x64.zip | 115734466 | `eaf84d33e33df588d516933c0216f5b11191ec0ab06c36f48e08fd7b34f0d16f` |
| TokenTracker-Setup.exe | 81395934 | `afdb4989a148c6f0cc11f5bc7767a2d87193c1ecf97038f3e5384a64640d790b` |
| TokenTracker-linux-x86_64.AppImage | 129489400 | `edb88371c93f3fd3a38d1f2d0ed8dd87820b8fd67a5834760294f9c8dfbfc11d` |
| TokenTracker-linux-x86_64.deb | 59269482 | `cee33761d515c050420bc9b485b0b45cf912a8f4ac4263ccbaa36179f88c7afe` |
| TokenTracker-linux-x86_64.rpm | 59255438 | `16bdfce4b1dbc07103de450d12900ce7c2b959d323164215b8dc75e87bbac696` |

新 Windows 草稿包的 983 项本地 hash 索引、109 个源码 blob、四项密钥模式和 PE 1.3.2.0/ProductVersion 精确来源已核对，实际安装/GUI/生命周期仍未执行，见 [Windows 候选交接](windows-cloud-acceptance.md)。私有证据为 `.tmp/windows-cloud/release-final-{inventory,windows-verification,source-equivalence}.json`。后续修正 `13216994` 仅改 Linux `#[cfg(test)]` 超时夹具及文档，已逐字节确认排除该测试块后的生产 Rust 源码一致，其余 CLI/前端/原生/构建输入不变；不是两个不同 Git tree 相同的声明。任何新的生产输入变化须使用新版本，不移动当前 tag。

修正提交 `13216994ac08e79120b9f0e7903409d40f109b0c` 的 [CI 38063114418](https://github.com/xiufengsun/TokenTracker/actions/runs/38063114418) 四个 job 已全部 success，包含完整 Windows Node24/包内 Node22 与安装器产出；[CodeQL 38063114397](https://github.com/xiufengsun/TokenTracker/actions/runs/38063114397) 和实际安全 check `114245795198` success、0 新注释。保留前一源提交的失败/取消事实；最后交接提交的精确检查以 [PR 当前 head](https://github.com/xiufengsun/TokenTracker/pull/772/checks) 为准，不把这份 CI 或旧审核包人工范围重新署名给新 artifact。

最终顺序：完成设备和付款模式范围验收 → 核对最终 PR 检查与生产输入 → 合并 main 并等待该精确 main CI → 核对 npm 1.3.2 → 在用户发行授权范围内公开这个已验证草稿 → 确认 latest 与下载、等待 Homebrew 正常自更新 → 经本人确认内容及渠道后发布公告。不要从后续文档/测试提交直接重新 dispatch 1.3.2。本次不新增扣款，其他年付/续费模式仍缺真实证据；未自动关闭其生产入口或将其视作已验收。原退款实际银行/钱包到账和收入满足合同条件后的首笔商户提款，仍由本人核对。

## 发行准备接续，2026-10-10

文档提交 `2384d16b3445ceeced9ecc048e52ac2a5192681e` 的 [CI 38060825861](https://github.com/xiufengsun/TokenTracker/actions/runs/38060825861) 四个 job 和 [CodeQL 38060825856](https://github.com/xiufengsun/TokenTracker/actions/runs/38060825856) 均成功。实际 Windows 人工包证据仍绑定下述 `83e7e0f1`，不升级为其他 archive 的验收。

Owner 本次选择“先不新增扣款，完成其他上线准备”。不创建其余年付/续费订单或扣款，不重做已完成的固定月付退款；其他已开放收费模式仍保留真实验收缺口，未修改生产开关。Windows 安装与登录请求仍待本人完成，完整托盘、系统协议返回和安装生命周期由本人执行。此前这些系统操作被自动审批拒绝，原因仅为 `blocked by policy`；没有更换工具绕过。临时隔离窗口已关闭，接续时应核对实际安装的客户端来源。

统一发行 workflow 新增 Boolean `publish`（默认 true）；准备时必须明确 `-f publish=false`。此模式仍构建六项资产、下载实际资产计算 `SHA256SUMS`，只跳过公开草稿和 Homebrew 通知。它会占用 1.3.2 的版本 tag，固定在 workflow 的准确提交；不得从其他提交重跑同一版本或移动 tag。发行安全专项最终改动通过 80/80；本机日志 `.tmp/windows-cloud/release-final-workflow-tests.log`。完整发行候选以随后实际 workflow/tag/draft 读回为准，尚未将这些准备写成公开发行成功。

正式 catalog 本次独立 GET 为 HTTP200、live/hosted/active，四项套餐为 USD4.99/月和 USD39.99/年，固定期/续费同价，仅 Waffo 入口开启；原 launch_at 保持。`checkout_verified=true` 是已授权开关，不替代其他付款模式或到账验收。私有记录为 `.tmp/windows-cloud/release-final-public-catalog.json`。[公告草稿](cloud-announcement-draft.md)已改为当前正式网站状态、确定的过渡日期和现行条款；仍未发送公告。

草稿构建 [38062816928](https://github.com/xiufengsun/TokenTracker/actions/runs/38062816928) 固定在 `a1f02b0889cecde6b0b7490ef8d5f086b996acb2`；已读回 tag 精确匹配、isDraft=true、公开 latest 仍 v1.2.2，Windows 发行 job 成功，其余构建及最终校验当时仍进行中。该源提交的 [CI 38062814160](https://github.com/xiufengsun/TokenTracker/actions/runs/38062814160) Rust 测试为 43 通过/1 失败：超时夹具在 250ms 内杀掉 shell，后台 PID 文件尚未创建；生产 registration 原本使用 3 秒。修复仅在 `#[cfg(test)]` 块使用相同 3 秒期限及 5 秒结束上限，保留超时断言和子进程存活检查，不修改生产函数或放宽清理要求。本机 Windows 未配置 Linux Rust 工具链，以修正提交的 CI 结果为准；此失败记录保留，不把失败构建写成全绿。后续仅该测试块与交接变化，不移动草稿 tag 或从新提交重跑 1.3.2；公开前仍核对最终受审源码与草稿打包的生产输入一致。

## 当前剩余发行工作，2026-10-10 Windows 接续

功能分支已同步到 `83e7e0f15dc20a1c210b55a4c81931430be12d63`，相对 `39208a10` 仅更新交接文档，应用仍为 1.3.2。[CI 38047796689](https://github.com/xiufengsun/TokenTracker/actions/runs/38047796689) 四个 job 通过，CodeQL 实际 PR check `114201224146` 为 success、0 新注释；PR 仍为 draft、CLEAN/MERGEABLE，main 为 `e6186b35`。公开最新发行仍为 v1.2.2，尚未统一发行 1.3.2。

本次 Windows 侧独立只读核对：live 为 hosted/active，原 launch_at 保持；正式订单 2、付款 1、订阅 0，已付 499 美分、已退 499 美分，1 项付款权益撤销。没有创建新订单、付款、退款或修改生产设置。正式五路由均 HTTP200，价格/条款/隐私三个在线 HTML 与当前 tracked source 字节一致；这些是 HTTP/账本核对，不代称新的网页 GUI 或实际到账。证据为 `.tmp/windows-cloud/acceptance-final-handoff-live.json`、`acceptance-resumed-83e7-live-refund.json`、`acceptance-resumed-83e7-public-site.json`。

该 head 的 Windows CI 审核包已在本机独立下载并验 hash，983 文件/109 源码匹配，四项现有密钥模式零命中；实际包的隔离原生窗口 30/30、包内模块 55 通过/1 权限跳过，本机新增导出源文件测试 2 通过/1 权限跳过。[Windows 本轮证据](windows-cloud-acceptance.md)明确记录 SHA、包与安装器 hash、截图仍处于价格载入的范围以及未覆盖的设备步骤。应用/原生/构建输入本轮未修改，后续文档提交的 CI 不冒充新的完整人工包验收。

| 剩余事项 | 验收与交付要求 |
| --- | --- |
| Windows 真实客户端 | 使用当前审核包验证 CSV/JSON 实际保存、同名文件保留、账号/实例切换和迟到结果、Pro 标识/胶囊布局、完整托盘/单实例/子进程退出、普通 OS OAuth/付款返回、安装/升级/卸载及本地数据保留；受工具拒绝的系统步骤由人工在专用设备完成 |
| 其他正式收费模式 | 固定月付及全额退款已完成；年付完整账期、自动续费首期/续扣/取消与拒付重试还需各自真实证据。工程先准备金额、方式与停止条件，再由 Owner 完成需要本人确认的受控交易；不要重复同一笔已验收购买 |
| 实际到账 | Owner 确认原退款的银行/钱包到账；真实收入符合合同提款条件后核对首笔商户提款。供应商 succeeded 和账户绑定不等于到账，unverified 不单独证明配置失败 |
| 统一公开发行 | 设备和相应验收范围完成后按 CLAUDE.md 合并流程执行：精确 main CI 后 npm、统一 macOS/Windows/Linux workflow 和六项发行资产，保持版本 1.3.2 一致；未经发行流程核验不要把分支审核包称作公开版本 |
| 公告与运维 | 最终核对退款/续费/客服说明、实际支持的支付方式与已验收范围，再发布公告；归档/删除计划继续关闭，另按其独立运行手册验收 |

正式网站、Vercel 访问、隔离数据库恢复、正式函数替换、价格、密钥、产品和提款账户均已有完成记录，无需重复设置或另建服务器。下方历史 preview/零交易/恢复未完成记录保留其原时间点，不作为当前待办。主干已有安全告警仍需保留各自审查范围，不将当前 PR 无新告警写成全项目零风险。

## 用户要求紧凑胶囊周期选择，39208a10

初版周期控件被用户指出过大，已按 design-taste-frontend 重排定价卡片并采用用户选择的小胶囊。当前源码 `39208a106b6861660c7bdda23b08878a21fa470d` 已推送，只有定价页与专用样式变化；应用版本仍为未统一桌面发行的 1.3.2。[UX 验收](cloud-pro-ux-acceptance.md)记录真实 128px/32px 视觉尺寸、44px 触摸范围、深浅色与 390px 布局及独立审查。[新 CI 38045978106](https://github.com/xiufengsun/TokenTracker/actions/runs/38045978106) 四个 job 全成功，[CodeQL 38045978194](https://github.com/xiufengsun/TokenTracker/actions/runs/38045978194) 与 check 成功、0 新注释。生产 `dpl_J6kCz1CaMBYezoRrEkvRoYW3coPK` READY，源码与 Git392 一致，五路由 HTTP200，三公开 HTML 源码相同，公开 CSS/胶囊模块和 Settings 1.3.2 均读回。正式网站另经同一浏览器真实查看小胶囊，约128px/32px、无横向溢出；结果页保留、视口重置，测试空间正常结束，隔离预览服务停止。Mac 新 bundle/src106/dist259 与当前源码绑定、包内模块/CSS HTTP200；最新 Windows CI 审核包和有限的旧 core 复用范围见设备交接。下面 92 的已完成部署、包与资金事实保留原时间点。

## Pro UI 初版 92d07c4e 已发布，2026-10-10

应用源码 `92d07c4eb6ac685196f55b0ba0a14580bfb9e61c` 已推送。[CI 38041985678](https://github.com/xiufengsun/TokenTracker/actions/runs/38041985678) 四个 job 全部成功，[CodeQL 38041985682](https://github.com/xiufengsun/TokenTracker/actions/runs/38041985682) 和安全 check 成功、0 新注释。本轮完整前端 1294 项通过，独立目标审查 161 项通过。

既有 GitHub integration 的同源码 READY 候选经正常 Vercel promote 发布，production `dpl_CxzWuecNoT7qm6PWDzQS6Y4egQsz` READY、正式域名绑定成功；五条路由 HTTP200，三份公开 HTML 与源码字节相同。公开 JS/CSS 含新版侧栏、44px 触摸尺寸和续费 switch，Settings 独立资源版本为 1.3.2。真实浏览器验收使用原 InsForge 和专用账号，[UX 验收](cloud-pro-ux-acceptance.md)记录浅/深色、390px、键盘及授予/撤回；发布后的核对为元数据和公开 HTTP/资源，不代称再次操作了生产网页 GUI。

Windows 1.3.2 审核包已独立下载，官方 archive digest、983 项 payload 大小/hash、109 项嵌入 core 源码及 EXE/DLL 1.3.2.0 元数据通过。[最新设备交接与包](windows-cloud-acceptance.md)保留实际 hash，下载与编译不代称 GUI/安装生命周期。Mac 内嵌资源已刷新，106 份 src、259 份 dist 匹配，包内 Node/页面/JS/CSS 实际 HTTP200；563 份 tracked 构建输入另与 Git `92d07c4e` 逐项绑定。浏览器最后由用户接管，已停止控制该空间；QA 的赠送权益和批次此前已完成撤回/停用，付款数据不变。不会为这次 UI 变更重复创建付款或退款。

## 正式固定月付与全额退款已验证，2026-10-10

用户完成一笔 USD4.99 固定月期真实购买，随后明确授权退款。供应商真实付款、完整自然月账期、会员和 Pro 标识已核对；付款回调一次投递 HTTP200。正式后台只提交一次 USD4.99 全额退款，供应商 succeeded，退款回调一次投递 HTTP200，账本 refunded_cents=499、已撤销付费权益；付款和退款各应用一次，原记录和账期保留。

独立退款前 10/10、退款后 11/11 通过，真实账号页显示退款记录并恢复至 11 月 9 日结束的旧设备过渡期，Pro 标识 false，免费过渡期读取/上传保留。launch_at、sandbox 和原 QA 未付草稿不变。[详细验收](cloud-live-payment-acceptance.md)列出私有来源和范围。无需再次要求用户完成这笔付款；银行/钱包到账、商户提现、其他正式收费模式和物理设备仍按各自证据处理。

用户新增的侧边栏 Pro 身份、付费卡内自动续费 switch 和付款流程精简已按 impeccable 完成并推送应用源码 `92d07c4e`，版本 1.3.2。[新版 UX 验收](cloud-pro-ux-acceptance.md)记录真实页面、键盘与 390px 布局、临时赠送权益撤回和完整测试；网站部署与当前提交 CI 在下方追加，旧 f515/282 不代称新 UX 已发布。

## 正式价格已启用，2026-10-10

Owner 明确要求 "启用吧 正式价格"。live policy 已从 preview 改为 active，`launch_at=2026-10-10T05:52:14.603712+00:00`。北京时间和新加坡时间均为 10 月 10 日 13:52:14。上线前注册的设备按现有规则保留 30 天过渡期，至 11 月 9 日 13:52:14；免费本地功能和排行榜继续开放，不自动扣款。归档、删除计划及上线公告均未开启。

生产 API 的签名查询重新确认商户、Store、正式密钥指纹以及四个 active/published SKU。全球未税基础价 **USD4.99/月、USD39.99/年**，自动续费与固定期同价。正式 catalog HTTP200，live/hosted/active、Waffo=true、`checkout_verified=true`，其他支付入口关闭。该字段来自 Owner 此次启用授权后设置的服务端开关，**不表示真实付款、退款或结算已验收**。

[正式 Pro 页面](https://www.tokentracker.cc/cloud)和完整 `/billing/checkout` 已发布。Vercel production `dpl_5tAaqWRtKe4hKYWTk8GEBGQ3mZvx` 为 READY、aliasAssigned=true，绑定源码 `f51520eed4cf1238638e1d335bd0934db87638db`；价格、条款、隐私三个在线文件与 tracked source 字节一致，五条正式路由均 HTTP200。[CI 38028332993](https://github.com/xiufengsun/TokenTracker/actions/runs/38028332993) 四个 job 与 [CodeQL 38028333034](https://github.com/xiufengsun/TokenTracker/actions/runs/38028333034) 全部通过。相对 282 仅更新三个公开说明文件，没有重写应用或原生源码。

使用既有专用 QA 账号通过真实 SDK 登录，正式固定月期 checkout 返回 HTTP200 和 `pancake.waffo.ai` 的生产收银台 URL。只创建一笔未付款 QA 草稿，没有使用卡或钱包；不得记为零订单或真实收款。付款、签名回调、真实首期/下次扣款、退款及银行到账仍需真实交易证据。私有索引为 `.tmp/rollout-20261010/review/launch-{waffo-prod-proof,policy-independent,catalog-active,production-readback,site-after,checkout-proof}.json`。不得重新设置 launch_at 或重复创建验收订单。

启用时独立只读复核的九项断言通过。两个既有 QA 账号的过渡期、读取/上传许可与无付费标识符合服务端结果，原 public leaderboard HTTP200；当时 SQL 确认正式订单只有上述一笔未付 QA 草稿，正式付款/订阅/赠送均为 0，此后真实付款与退款见本文开头。B 的首次 account 返回 503 billing_operation_failed，36 字节原失败/hash 保留，必要单次重试为 HTTP200；没有捕获该次上游根因，不称永久稳定或冷启动已经修复。证据为 `launch-independent-readonly-first.json`、`launch-final-readonly-followup.json`。

本次生产网页启用已完成。CLI 首次上传曾因 TEAM_ACCESS_REQUIRED 被拒，保留失败；随后提升同一 f515 的已有 GitHub integration READY 部署，未更改权限或提交作者。物理 Windows 新导出、安装器/完整入口/OS 返回及此前锁屏中断的最后移动视口截图继续按下面设备清单验收，不由网页发布代替。桌面安装包和主干版本尚未统一发行。

## 启用前工程验收，1.3.1 / 282ffa95

2026-10-10，源码 `282ffa95370a8c84a3911908079a46a38b70a88e` 已推送并独立读回。[CI 38024326226](https://github.com/xiufengsun/TokenTracker/actions/runs/38024326226) 四个 job 与 [CodeQL 38024326217](https://github.com/xiufengsun/TokenTracker/actions/runs/38024326217) 全部通过。实际CodeQL门禁114132236221为success、0条新注释，未关闭主干原有告警。Windows Node24/包内 Node22 各 **3869 通过/40 条件跳过/0 失败或取消**，.NET **119 通过/1 个 Windows 符号链接权限跳过**，完整应用及安装器编译通过；Mac Node **3903/4 跳过**、原生 **247 项**；Linux Node **3899/8 跳过**及 **4 项架构检查**，Rust 格式/clippy/测试通过。独立前端 **1243 项/143 个文件**绑定 c7，282 仅改两处原生源码，前端 Git blobs 相同。

c7 的 Windows [首次 Build](https://github.com/xiufengsun/TokenTracker/actions/runs/38023611765/job/114129674138) 缺少 System.IO，原失败保留。补显式 using 后，官方 .NET8.0.425 完整生产 csproj 交叉构建与上述真实 Windows CI 都退出码 0。Mac QA 目录复用修复及真实保存结果见下文。

现有付费 InsForge 的 **14 个正式 handler 已替换**，**19 个受审产物仍绑定 `9c19419c`**。源码/hash 独立读回一致，direct/gateway 共 28 项探测通过；43 个函数中的其余 29 个 metadata 不变。前置 preview 回归 59/59；首轮 post 的 48 通过/11 个 `cloud_access_unavailable` 503 原样保留，同期 PostgREST 有数据库连接故障；第二轮完整真实 HTTP **59/59**。当前回归通过不证明所有失败请求的深层原因或永久稳定。live 保持 preview，收费、促销和归档关闭。私有来源为 `.tmp/rollout-20261010/review/deployment-result.json`、`cloud-gate-investigation-index.json`。

供应商完整 gzip 备份 **843,788,653 字节**已在 PostgreSQL **15.18** 隔离副本恢复：**143 表、13,156,108 行**，元数据、**5,616 项有效权限比较**及回滚验证通过。仅调整一行备份头兼容性，原 dump 字节保留。来源为 `.tmp/rollout-20261010/restore/supplier-restore-result.json`、`supplier-full-metadata-parity-result.json`、`supplier-effective-privilege-parity-result.json`、`supplier-rollback-result.json`。不代称公开 VPS、平台 storage 或真实用户迁移已经完成。

282 的普通/QA Mac 新包 build、签名 strict 检查退出码 0，签名前 706 个嵌入文件一致；签名后 705 个嵌入文件字节一致，唯一 Node 签名字节差异单独记录。36 个源码 Git blob 精确绑定 282，相对 c7 仅两个原生文件变化；来源为 `.tmp/rollout-20261010/native/package-parity-282-final.json`。

测试包未正式发行。Cloud 日汇总 CSV/JSON、三端文件保存确认和初始登录 gate 已实现，文件记录 UTC、估算 USD、请求范围及实际可读范围。此前 21 项 redirect/SDK HTTP200 PKCE 为预检；最新 23 个 provider redirect 已读回且其他配置相同。

普通 GitHub OAuth 已真实返回 /billing/checkout?intent=trial，显示 preview/试用关闭，URL 无凭据、session intent 清除。

网页 CSV/JSON 真实下载已验证：CSV 3667 字节/12 行（10 个有记录日期），JSON 4376 字节/10 行，schema、UTC 和估算 USD 元数据匹配；验收摘要记录范围、数量和 hash；导出文件仅在私有0600位置保留，不公开用量行或金额，私有来源为 `.tmp/rollout-20261010/ui/downloads/csv-proof.json`、`json-proof.json`。首次网页 JSON 曾显示通用错误且无下载，未捕获根因，原失败保留；正常重试的 6 个 HTTP200 中只有 4 个属于导出，另 2 个为背景 daily。

WKWebView 首 CSV 成功、第二 JSON 的 QA 重复建目录失败也保留；282 修复后的真实 Mac 第二轮 8 个事件均通过：CSV618字节、同名-1副本618字节、JSON554字节均与真实A快照hash一致、权限0600；实际iframe禁止、路径穿越拒绝、写失败反馈及恢复均有回执。第一轮report/profile/bootstrap/原CSV hash保留。索引为 `.tmp/rollout-20261010/native-auth/mac-ipc-independent-result.json`，新QA签名binary SHA以7548f66a开头，NativeBridge源码SHA以375c4d55开头。

实际桌面截图 `.tmp/rollout-20261010/ui/export-native-desktop.png` 已取得且private0600；390px DOM无横向溢出、两个日期label、Tab输入焦点outline2px见 `export-mobile-keyboard.json`。随后Mac锁屏，Cua解锁失败，未继续UI或换工具；最后390px像素截图待Owner解锁，不撤销已完成的功能、桌面像素和DOM/键盘证据。以上页面/前端均为c7且与282 frontend Git blobs一致；普通非QA原生OAuth的OS返回尚未由网页OAuth或QA文件保存代替。 Windows 新 WebView2 下载和 OS/完整入口验收见 [设备清单](windows-cloud-acceptance.md)。

当前Windows审核archive已独立下载，与GitHub digest一致；984个文件大小/hash、109个源码blob以及实际checkout tree与282逐项匹配，ZIP/安装器具体hash见 [Windows包来源](windows-cloud-acceptance.md)。本机4项可用私钥/管理key模式零命中，不冒称Windows生产私钥扫描或GUI/安装器运行。启用前公开catalog为HTTP200、live/hosted/preview、launch_at=NULL、checkout_verified=false；正式启用后的读回以本文开头为准。

| 当前剩余门槛 | 负责人和动作 |
| --- | --- |
| 当前 CI 与验收证据收尾 | 当前源码 CI/CodeQL 已通过，Windows archive 已下载核对，Mac 第二轮文件索引已完成。最后390px像素截图等待 Owner 解锁，其他已完成验收保留 |
| 正式 HTTPS 发布与回滚 | 正式 Dashboard 和生产 checkout URL 已验证；实际付款后的返回、失焦和重开恢复仍需真实交易验证，回滚须保留 launch_at 和财务记录 |
| Windows 实际设备 | Owner 提供测试电脑和必要系统确认；工程验证新导出、OS 返回 App、完整 Main/托盘、单实例/JobObject、安装/升级/卸载及数据保留 |
| 真实付款与结算 | 正式固定月付及全额退款已验收；其余正式收费模式和商户提款各自保留证据边界，收入满足合同条件后核对首笔提款和到账 |
| 正式价格与启用 | Owner 本次授权已执行；公开价格/条款/隐私已更新，无自动扣款。资金验收、桌面统一发行和上线公告分别保留其授权及证据要求 |

以下历史记录保留原始 SHA、环境和失败，不作为当前版本验收。Windows 原码生成/resume 的 NTFS 管理入口是可选能力，仍 fail-closed；可使用已验证的 Mac/Linux 管理程序，不列为正式收费的必需 Owner 门槛。

## 1.3.0 / 6abe2701 工程记录（历史）

受审提交 **6abe270167182afe5511939b10a950e2b0a2776e** 的 [CI 37989219495](https://github.com/xiufengsun/TokenTracker/actions/runs/37989219495) 全部通过：Windows Node24 与实际包内 Node22 各 **3858 通过/40 条件跳过/0 失败或取消**，.NET **117/117**；macOS Node **3892/4 跳过**及 **239 原生测试**；Linux Node **3888/8 跳过**、Rust 格式/clippy/测试通过。CodeQL 实际门禁 **114019867015 success / 0 新注释**，分析 1926208544 的 merge tree 与该提交相同；14 条主干已有告警仍保留，未禁用查询。通知与同步锁夹具修复现已在 Mac/Linux 全量执行；实际已核验 Windows 包内模块的组合专项另为 **67 通过/4 POSIX 跳过**。

该工程提交相对 c93c9080 只改交接与两个测试夹具，应用、构建和 workflow 输入相同；下面 **c93c9080 实际包的 984 文件/109 源码/30 原生窗口/55 包内专项**继续保留其精确来源，不冒充 6abe2701 包的人工验收。新 CI 的安装器已编译并上传，GitHub artifact 11645225619 为 195991587 字节、digest **4aae4e286d81a4c78245afe3b8a6797d5a8ead24669d3191814164c8e0038f32**；本机没有下载或人工验收该新 archive，不把供应商 digest 写成本机 hash 核对。本文随后仅更新交接；完整当前检查仍以 [PR 当前 head](https://github.com/xiufengsun/TokenTracker/pull/772/checks) 为准。

后端最新只读部署计划补入独立受审的 leaderboard-refresh：**19 个候选、16 个现有源码/metadata 回滚快照、2 个正式源码匹配、14 个待替换、3 个历史支付 webhook 缺失**。原 18 个候选 hash 与此前计划相同；远端函数 metadata 在读回前后完全一致。回滚目录及文件共 36 项 NTFS ACL 核对，无 Owner/System/Administrators 以外的 Allow。没有替换正式函数；隔离恢复与 preview 回归仍先于这 14 个替换。证据 acceptance-current-reviewed-rollout-plan.json；旧 18/15/13 计划仅为此前记录。

[6abe2701 Preview](https://dashboard-1to1paddr-sunxiufeng1992-8555s-projects.vercel.app) deployment **6970688267** 为 success，账单/价格/条款/隐私四路由仍需正常 Vercel 登录，未通过页面验收。UTC 20:57 正式后台只读核对仍 **hosted/preview、launch_at=NULL、live 订单/支付/订阅均 0**。最近 fetch 的主干 e6186b35 已包含，功能分支已推送且工作树干净，PR CLEAN/MERGEABLE、保持 draft。13 份交接/87 个本地链接和 9 处 1.3.0 版本已核对；后续文档改动另按当前工作树核对链接。证据 acceptance-notify-final-checkpoint.json。价格与已完成的密钥/结算账户设置不变；真实资金、恢复、完整前端、Windows 生命周期和 Owner 最终条款/启用事项继续按下面门槛处理，**仍未达到正式收费发布标准**。

## 后续测试夹具修复：应用源码未变

文档提交 7bd905d6 的 CI 37985950893：Linux、Rust、macOS（3892/4 跳过及 239 原生）通过，Windows Node24 为 3858/40 跳过；包内 Node22 为 3857 通过/40 跳过/1 失败，native account publication 用例报未处理的 SYNC_BUSY 拒绝，不记为全通过。源码与下面 c93c9080 相同，失败来自用 30ms 睡眠建立重叠、500ms 实时时限和延后 await 的测试夹具。

两个成功用例现观察真实文件锁两次 EEXIST 后才释放锁，先断言队列尚未产生；Promise 拒绝立即处理，并在成功路径控制时钟，独立的 busy-lock 拒绝用例继续使用真实 deadline。所有原始 token/队列断言保留，未改产品锁时限或文件超时。本机隔离 Node22/Node24 均 **27/27**，无失败/取消/跳过，最终测试文件 hash d82ea95282c4d3a2c3bebf2c064c4cce072cf8d99c8152fce0e37e14e65be185。完整检查按 [PR 当前 head](https://github.com/xiufengsun/TokenTracker/pull/772/checks) 读取；下面 c93c9080 的应用与实际包证据继续保留其精确来源，不将旧 CI 升级为后续 head 的结果。

e9b06987 的 CI 37987644688 随后在 macOS env split-string 通知夹具读到了空标记：3891 通过/4 跳过/1 失败，原生 XCTest 未执行，不记为 macOS 通过。12 处仍直接写标记的夹具已统一写自己的临时文件再 rename；读者继续检验空内容，未放宽参数或坏命令断言。产品通知代码未改。本机 Node22/Node24 的通知与锁组合各 **67 通过/4 POSIX 条件跳过/0 失败或取消**，71 项；新增文件 hash 424ad35f5012fd52c06a58050ac0d0852bca5ae7b997a38d8c228029a38a9400。POSIX env 实际验证继续由当前 Mac/Linux CI 提供。

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

2026-10-10（Asia/Shanghai）核对。Owner 已确认全球未税基础价 **USD4.99/月、USD39.99/年**，自动续费与固定期同价。工程已完成下列生产准备；**尚未达到正式收费发布标准**，实际资金、结算和原生设备门槛必须有真实证据。生产 policy 仍为 preview，launch_at 为 NULL，收费、会员限制、促销和生产归档均未启用。

## 已核验 checkpoint：Node22 中文路径兼容修复

上一已核验应用 checkpoint 为 **1.3.0 / 896baa52b060dac3f7d34ce22312a0f184a87fcd**。补查安装包实际使用的 Node22.22.2 发现递归复制中文目录会原生终止，退出码 3221226505；此前同应用源码的完整 Node22 结果为 3825 通过、1 个文件失败、47 跳过，缺少该崩溃文件内另外三项结果，不能按完整用例通过计数。隔离目录的 native copy 复现相同退出码，而保留全部条目的 JS 遍历能成功；[Node 官方问题记录](https://github.com/nodejs/node/issues/59636)有同类 Windows Unicode copy 退出。

技能导入与链接失败的复制分支现在为 Windows 的 fs.cpSync 添加恒真 filter，选择 Node 的 JS 目录遍历；不跳过文件，保留同步调用、嵌套路径 guard 和链接处理。新回归用隔离子进程实际复制中文用户目录、嵌套 UTF-8 文件，并强制 EPERM 覆盖链接 fallback；不操作用户技能。TRAE trim fixture 使用同一 Windows 遍历方式，继续检验完整的裁剪后运行库。

修复后的实际 Node22.22.2 完整回归：**363 文件、3877 项，3830 通过、0 失败、0 取消、47 跳过**，188 秒自然结束，四项 profile 隔离、子进程 PATH 固定同一 Node，未修改系统 PATH。四份变更文件运行前后 hash 一致，提交 Git blob 全匹配；证据 acceptance-windows-node22-copy-full-fixed.json/log、acceptance-node22-copy-commit-binding.json。Node22 专项 62 通过/6 条件跳过，Node24 专项 74 通过/6 条件跳过，均无失败或取消。

Windows CI 使用实际打包 Node22 再跑完整测试，另保留 Node24 全量。[CI 37973812448](https://github.com/xiufengsun/TokenTracker/actions/runs/37973812448) 四个 job 全通过；Windows 两个 Node 版本均为 3840 通过/37 跳过/0 失败/0 取消，分别 201 秒和 167 秒，.NET 117/117；Linux Node 3867/8 跳过、macOS Node 3871/4 跳过及 239 项原生测试全通过。十项本机链接权限跳过在 CI 实际运行通过。证据 acceptance-node22-copy-ci.json 与各 job log。

受审 head **29b02f5a9960cdb0b16cfb2d5215ad1c9f4336c1** 的 Windows 产物已独立下载核验：archive 195992529 字节、SHA256 7af2e4e1a6e81d809536a9c138edb92caa19093384c0a2ad5a767f8ca4bdd48f，与 GitHub digest 相同；checkout a4e489556b14aaa67a32dceb46d67fc71a92eb33 的 tree 275f67f25cbe7d2d81cba5fbebeea85b31060851 与受审 head 一致。982/982 文件大小/hash、107 份嵌入源码 Git blob 全匹配；四项现有私钥/管理 key 字节模式零命中。ZIP 115719886 字节、SHA256 a33757e232db0499cfb03792805a58f5d09ba6b164694c75174220d164c79e80；Inno 81394638 字节、SHA256 692c733aae89b33f3a0b0e96dff8dd8e938cf64ea63489508ed595eea51c5082。

实际新 CI DLL/EmbeddedServer 的 30 项原生窗口检查通过，node22-copy-ci-native-final/native-smoke.json；实际包内 Node22.22.2/OpenClaw/中文技能复制另有 18/18，acceptance-node22-copy-packaged-modules.json。前两次宿主构造失败（多复制 CLR host 文件影响 framework 查找；Smoke deps 预解析 harness 内 DLL）均保留失败记录；最终只复用 Smoke 测试宿主并移除其应用 deps 绑定，发布 DLL、WebView2 loader 与 EmbeddedServer 全部来自新包，源码位置断言通过。没有操作已有用户安装；不是完整 Program.Main/单实例/Job Object、OS 协议支付返回或安装/升级/卸载证明。

CodeQL 的 workflow 37973812430 执行成功，但 PR 的 CodeQL 安全门禁 113968044957 失败，报 27 条新注释（13 high、14 medium）；分支总计 42 条 open，主干 23 条 open，按告警编号比较有 21 条仅在分支存在。扫描流程成功不等于安全验收通过，注释数量也不等于已经确认的可利用漏洞。原始注释、分支/主干比较私有保存；工程继续逐项判定和修复，不能把 Owner 登录或资金门槛当作这部分工程工作的替代。

该历史 checkpoint 受审 head 为 29b02f5a，应用源码为 896baa52。此前 CI 37973032260 的 macOS notify fixture 在标记文件刚创建、尚未写完时读取到空内容；29b02f5a 仅把 Bun/Deno 测试标记改为临时文件写完后 rename，不改变产品行为，不忽略空内容失败。Windows 对应目标文件 40 通过/4 条件跳过；旧 CI 被替代运行取消，不能记为全绿。替代运行全部构建/测试通过，结果见上；安全门禁独立保持未通过。

## 前一 checkpoint：Windows Node24 全量回归

应用 checkpoint 已推进到 **1.3.0 / 60b8935b0211d249771765aeeec03b12778f0a6d**。本机 Node24.19.0 的 362 文件完整回归在 184 秒自然结束：**3876 项，3829 通过、0 失败、0 取消、47 跳过**，未触发测试超时。四项 profile 隔离，SQLite CLI 仅加入测试子进程 PATH。运行前后 29 份变更文件的 SHA256 一致，并在提交前再次逐文件校验；证据 acceptance-windows-release-full.json/log 与提交绑定记录。下文 b0a6544d 的 61 项失败是此前快照。

修复了真实 Windows OpenClaw npm 启动问题：从 PATH 对应 npm prefix 的 package.json 解析 JS bin，以当前 Node 直接启动；路径中文、空格、&、% 与特殊参数保持字面值，不交给 cmd.exe 重解释。命令 hook 与 session plugin 共用启动器，超时、启动错误和信号退出均不能误报成功。53 项相关回归通过。其他修复包括 where/which 探测夹具、中文系统默认语言、原生路径分隔符、SQLite WAL 写进程退出等待，以及 NTFS 大 inode 数字下的测试哨兵。

47 项跳过保留具体理由；本次新增的平台限定用于 Unix nvm/procfs、POSIX env/shebang 和 Linux Bash 打包夹具，Linux/macOS CI 仍执行这些检查。Windows 原生进程/端口、Node 通知链与目录 junction 检查仍运行。POSIX mode bits 不作为 NTFS ACL 证据；UNC 前缀分支用本地可读别名验证，不等于真实 WSL 挂载验收。

Windows CI 已扩大为完整 Node 回归，并在 Dashboard 构建后运行；SQLite 3.54.0 官方工具的大小及 SHA3-256 在解压前校验。这是测试依赖，没有加入产品或系统 PATH。[CI 37970035795](https://github.com/xiufengsun/TokenTracker/actions/runs/37970035795) 四个 job 及 [CodeQL 37970035738](https://github.com/xiufengsun/TokenTracker/actions/runs/37970035738) **全部通过**。Windows Node 为 3839 通过、0 失败、0 取消、37 跳过；本机额外跳过的十项符号链接测试在 CI 实际通过。macOS Node 为 3870 通过/4 跳过，Linux Node 为 3866 通过/8 跳过，均无失败或取消；Windows .NET 117/117。日志 acceptance-release-ci.json/log，差异为 acceptance-release-ci-skip-comparison.json。

60b8935b 新候选产物已独立下载核对：archive **195989292 字节 / SHA256 c24b1da9e8f461a0082dc58fe3c8a47d5f7415e14fea8b5506e04558e7685a80** 与 GitHub digest 一致。实际 checkout f828941f2f934887d08153402a60d4ebcd8d7e5b 的 Git tree **649e60a7dca5380593263e2d90031c7aa85f49b2** 与受审应用 head 相同；**982/982 文件大小/hash、107 个嵌入源码 Git blob** 匹配。ZIP **115719733 字节 / SHA256 bfd3dcc267e60841fac380c67de56dd2378ea67fde3a0565f902524020cc7012**；Inno **81391778 字节 / SHA256 9a2622e808153a1ae240b8f7abc864a3b6816dfaba9f387dd97b6e27c32366c4**。四项现有私钥/管理 key 字节模式零命中。证据 acceptance-release-artifact-download.json、acceptance-release-artifact-verification.json；不沿用旧包 hash 或已清除的 QA 凭据扫描数量。

实际新 CI DLL/EmbeddedServer 已通过 **30/30 原生窗口检查**，release-ci-native/native-smoke.json；实际打包 Node22.22.2 与包内 OpenClaw 模块另通过 **17/17**，acceptance-release-packaged-openclaw.json，不使用仓库模块或系统 Node。Node24 全量与打包 Node22 的这组专项范围分开，未称 Node22 全量通过。安装器生命周期、Program.Main 完整托盘、操作系统协议付款返回、真实 WSL 挂载和 NTFS ACL 仍无本轮通过证据。

同轮正式后台只读复核仍为 hosted/preview、launch_at=NULL，生产订单/支付/订阅全部为 0，acceptance-release-live-state.json。Waffo 查询未请求账号/银行号码，仍为 payoutEnable=true、绑定匹配、channelStatus=unverified、channelVerifiedAt=NULL；最新响应保留在受限私有目录。未启用收费或改变商户账户。

## 源码、候选版本与审核

- 分支为 feat/cloud-subscriptions，草稿 PR 为 [#772](https://github.com/xiufengsun/TokenTracker/pull/772)。最新主干 e6186b350df7942f356ef9155af71fe81a9a99d1 已通过 ac9cfd8e 合入；六处文案冲突按键合并，Sessions 与 Pro 的独立修改均保留。最近 fetch 没有新增主干或功能分支提交。
- 应用审核 checkpoint 为 268896e7a1fabbe75f89f302d0bc5ed7b5cb5a4a。已修复 checkout 恢复缓存，只持久化六个允许的订单字段；用户身份运行时派生，密码、token、邮箱、收银台 URL 和额外字段不进入缓存。CodeQL 高危告警自动关闭，无人工 dismiss，功能分支开放告警为 0。
- 初始 1.3.0 版本 checkpoint 为 **1c96a2ccb67a00a4037eddb7b8a5c613085c5a83**，通过 npm version --no-git-tag-version 同步所有平台和锁文件，不创建远端 tag，不复用已发布的 v1.2.2。该应用提交已通过完整 CI；安全修复 checkpoint 8497d6e9 亦通过完整 CI/CodeQL；后续精确 SHA 的 checks 以 PR 为准；合入 main、npm 发布和统一桌面发行遵循 [CLAUDE.md](../CLAUDE.md)。当前没有公开 Release、收费启用或公告。
- 前一应用 checkpoint 为 **1.3.0 / b0a6544d039ab29e2add90c06a2e0da79201168e**，包含 Roo/Kilo Windows 盘符修复及验收工具修复。其 [CI 37965509474](https://github.com/xiufengsun/TokenTracker/actions/runs/37965509474) 四个 job 和 [CodeQL 37965509485](https://github.com/xiufengsun/TokenTracker/actions/runs/37965509485) 全部通过；草稿 PR 仍无冲突。下文旧 checkpoint/包只证明其各自来源。

## 已执行的验证

证据位于本机 .tmp/windows-cloud/，不进入仓库；私钥、测试账号凭据和完整供应商响应位于仓库外受限 NTFS 私有目录。

| 检查 | 结果与范围 |
| --- | --- |
| 完整 CI | 1c96a2cc 的 [CI 37956050272](https://github.com/xiufengsun/TokenTracker/actions/runs/37956050272) 四个 job 全部通过：Linux 全仓 Node/校验/构建、Rust fmt/clippy/tests、Windows .NET 117 项及完整 ZIP/Inno 安装器构建、macOS 全仓 Node 与 XCTest 239 项；[CodeQL 37956050235](https://github.com/xiufengsun/TokenTracker/actions/runs/37956050235) 同步通过。安全修复 8497d6e9 的 [CI 37960201255](https://github.com/xiufengsun/TokenTracker/actions/runs/37960201255) 及 CodeQL 37960201210 亦全部通过；后续文档提交 checks 读取 PR，不升级旧包来源 |
| Dashboard | 138 文件、1192/1192 通过，acceptance-dashboard-rc.log；缓存修复目标组 125/125，typecheck 通过 |
| Windows .NET | 117/117，integrated-dotnet.log 与 test-results/integrated-windows-native.trx；自包含 win-x64 构建成功 |
| Cloud 目标组 | 606 通过、10 跳过、0 失败，integrated-targets.log；不等于全部 Windows Node 测试 |
| Windows 全仓 Node | 旧未隔离快照为 3728 通过、80 失败、20 取消、38 跳过。新 Node22 隔离 USERPROFILE/HOME/APPDATA/LOCALAPPDATA 对照为 3738 通过、70 失败、20 取消、38 跳过；最新主干 e6186b35 为 3343 通过、93 失败、20 取消、34 跳过。98 个 not-ok 输出包含取消及父用例，97 个名称/文件在主干匹配；余下一项 trim 的依赖完整主干专项复现相同 Node22 fs.cpSync 进程退出，Node24 该组 4/4。没有把匹配名称当作全部原因分析，也不把全仓写为全绿 |
| Windows 同步专项修复 | 上述三项 sync-background 失败来自未隔离 APPDATA/LOCALAPPDATA，读取真实 Cursor 数据与发起额度请求；隔离两个目录后 27/27，acceptance-sync-background-isolated.log，加入 Windows CI |
| Windows 继续排障 | TypeScript 验证改为当前 Node 启动 Dashboard 已安装且与锁文件一致的 compiler，避免 execFile 启动 npm.cmd 的 EINVAL；Markdown 索引用 POSIX 分隔符，11/11 专项通过。Ark timeout fixture 仅对 arkcli 返回匹配的 where 路径，修复把 Kiro 等其他查询也送进永不结束模拟的卡住；该专项通过。随后 Node24 全量运行在 172 秒自然结束，3764 通过、67 失败、0 取消、38 跳过，未触发 120 秒文件超时。日志 acceptance-windows-after-triage.log；此快照早于下述目录修复，仍不是全绿 |
| Roo/Kilo Windows 目录修复 | 发现自定义 TOKENTRACKER_KILOCODE_ROOTS 按冒号拆开 Windows 盘符，已改用系统 path.delimiter：Windows 多目录使用分号，Unix 继续冒号。实际临时目录扫描、token 聚合、重新运行去重与同一记录 backfill 共 14/14 通过，并加入 Windows CI。该 src 改动后的候选包已重新构建和独立核对，见最新候选包行；8497d6e9 的旧包仅证明其原始版本 |
| 修复后完整 Windows 回归 | 精确 b0a6544d、干净工作树、Node24.19.0、四项 profile 隔离，361 个文件自然结束：3869 项、3770 通过、61 失败、0 取消、38 跳过；168 秒，未触发 120 秒测试文件超时。acceptance-windows-after-drive-fix.json/log。比排障前快照减少六项失败；仍需继续逐项分析剩余失败，不是发布通过结果 |
| 前一 Windows 候选包 | b0a6544d 的 archive 195982701 字节、SHA256 4e9e35e9abd18b817c3d53c97dc45fd4ed156a614d3f9c22ec8f281f3316b06c，与 GitHub digest 一致。checkout 7fed619a2dbadde08353923ec62128adcb1cb10f 的 tree fda90533f0c2beb2df425e13327ea67046d4a09b 与 head 一致；981/981 文件清单/大小/hash、106 嵌入源码 Git blob 匹配。ZIP 115718626 字节、SHA256 cb394f582aee5726b89c45eb983f2815f9218ae55cb701368eefbc7a75166bb3；Inno 81385377 字节、SHA256 424b9e3fd37b7e0b46cd05bd69d43059320f99fccac8b24791ca5c6e641a362f。四项现有私钥/管理 key 字节模式零命中，未宣称重新扫描已清除的旧 QA 凭据。实际新 CI DLL/打包 Node 原生 30/30 通过，triage-ci-native/native-smoke.json；安装器生命周期、完整托盘及协议付款返回未执行 |
| 补充 Node24 Windows 对照 | v24.19.0、相同已安装依赖，主干 Dashboard 已独立构建，全部 profile 隔离。两边 usage-limits.test.js 均超过十分钟不结束，仅终止这两个确切测试进程以收尾；候选输出 3742 通过、69 失败、38 跳过，主干 3347 通过、89 失败、34 跳过。用例总数因未完成文件不同，不替代 Node22 完整快照，也不是通过结果；日志 acceptance-windows-node24-*.log |
| 当前原生窗口 | 1c96a2cc / 1.3.0 的干净发布目录通过 34/34 原生检查，明确断言使用打包 Node 而非系统 fallback；普通 UI 登录 B、重载保持、退出后重载清除、切换 A 的 7/7 检查通过。实际身份以邮箱与 UUID 核对。价格/固定期/preview 禁用已验证；最终 CI 产出 DLL/打包 Node 另执行 30/30 窗口/bridge/浏览器/页面检查通过；首次复制宿主缺少 WebView2Loader 的失败记录保留，补齐 CI loader 后通过。不是完整 Program.Main、付款协议返回或安装器生命周期证明 |
| 托管真实 API | 两个专用 auth 账号的登录/刷新轮换、账号隔离、无效赠送码、基础表与管理 RPC 拒绝共 16 项通过，acceptance-auth-gifts.json；生产 preview catalog/account/未登录拒绝/checkout 前置关闭共 8 项，acceptance-live-preview.json。没有成功 Windows 礼遇兑换或真实付款证明 |
| 函数与权限 | 当前 18 个 Cloud 和 14 个私有自部署函数构建成功。gift 远端源码与当前构建逐字节一致，四表 RLS 开启，客户端不可直接读 gift 管理数据/RPC；财务三表仅本人 SELECT，匿名拒绝 |
| 包来源 | 最终源码 8497d6e998369a8d4c90b2901ec089ed5dd7930a 的 CI artifact 已独立下载：archive 195981496 字节、SHA256 241d97ae378869532f172976b4662104696648b3af73e3410de4979cb80dc6c8，与 GitHub digest 一致。实际 checkout 为 7fd5fbfb86e6dda495fb773a8e09465a8eb0198d，Git tree 与受审 head 相同。1.3.0 ZIP 115718586 字节、SHA256 c3fab9a59fbe318c9d016897d1db7d712bceb53daba5ce1fa75bac64e9323fd4；Inno 安装器 81384336 字节、SHA256 0f898ddd528997710ce6684757b471b6caab81d8fbc3d02d1a520003a30edd30。解压 981/981 文件大小与 hash 一致，106 个嵌入 CLI/入口/清单源文件与 Git blob 一致，10 项实际私钥/管理 key/已撤销 QA 凭据的逐字节扫描命中为 0。安装器尚未执行安装/升级/卸载。 本地干净包 379 输入/981 文件；旧输出残留被拒绝并保留 |

## 后台安全复核

- InsForge advisor 全量扫描发现两张 2026-07-21 的历史 device/token 备份表未启用 RLS，匿名及 authenticated 有直接访问权限。已通过 20261010000000_secure-legacy-device-backups.sql 对这两个确切表启用 RLS、撤销客户端与 PUBLIC 权限；可选表不存在时跳过。保留全部行及管理员访问，不改其他业务表或客户数据。
- 前后行数一致、管理员 SELECT 保持，四个匿名/登录客户端实际 HTTP 读取均拒绝；重新扫描 rls-disabled 项为 0。证据为 acceptance-security-migration.json、acceptance-legacy-backup-http.json 与前后 grants/counts。
- 不把扫描全部告警写为清零：仍有 87 项 server-only RLS 无客户端 policy，以及一项数据库缓存命中率 73.29% 的性能告警。客户端角色无 BYPASSRLS，服务角色有访问权限；未增加公共 policy、未 suppress 告警、未更改付费实例规格。性能趋势和服务端权限仍按运行手册复核。
- 本轮仅用于验收的 A/B auth 账号已通过官方管理 API 删除，旧密码登录均为 401；gift 白名单仅移除本轮两项，原有两项保持。未删除财务记录或个人账号。验收凭据文件已移除密码/token；这些历史测试不能复用已撤销凭据。

## 早期正式后台准备的独立读回（历史）

- InsForge CLI 0.2.8 已安装、登录并关联现有 tokentracker 项目。此机器的系统 Node16 不满足 CLI 要求，CLI 专用 shim 使用已校验的 Node22.22.2，其他工具和系统 Node 不变；npm 更新可能覆盖 shim。项目配置和凭据均不提交。
- 备份 pre-pro-acceptance-20261009 已读回 completed。没有在生产执行恢复；隔离恢复演练仍为独立门槛。
- 正式后端的纯 schema/RPC/RLS 导出已私有保存并核对：470527 字节，SHA256 745c6196e64fa7725791a29bf0b451542fc14a66faa311a8b46ff6b84aad085f，包含 91 个表、146 个函数和 91 条 RLS 声明；未请求客户行数据。这不是完整供应商备份或恢复成功证明。当前没有可复用 InsForge 分支，本机无可用 Docker 环境；隔离恢复等待已有主机，或 Owner 明确付费分支的预算及运行时限。
- 已部署 tokentracker-billing 与 tokentracker-waffo-webhook 两个正式新增函数并读回源码逐字节一致，原有 41 个函数元数据不变。18 个候选函数的部署计划已核对：15 个现有远端源码/metadata 已保存用于回滚，2 个与候选完全一致，13 个旧同步/榜单 handler 与候选不同；3 个非 Waffo 历史 webhook 当前不存在。没有把构建成功写为这 13 个已部署，也没有开启会员限制。隔离恢复和 preview 免费/设备/导出回归仍先于替换。
- Owner 提供的 RSA2048 文件已规范化为标准 PEM，正式签名查询证明密钥可访问目标 production 商户/Store。八项 Waffo server secret 均写入并独立读回，包含 DER 指纹；没有进入 VITE、Git、安装包或日志。
- 四个套餐已发布为 active production 版本，USD4.99/月、USD39.99/年，续费/固定期同价，完整账期，无供应商试用；没有改动既有无关产品。
- 正式 HTTP webhook 已注册并读回：目标为现有后台 /functions/tokentracker-waffo-webhook，prod、12 个对应事件。旧回调不变；无签名 POST 返回 401 invalid_signature。未发生真实签名生产交易通知。
- 正式 catalog 返回 preview、配置可识别、checkout_verified=false；真实测试账号发起 checkout 返回 503 checkout_not_launched，在创建订单前拒绝。生产 orders/payments/subscriptions 均为 0。
- **提款账户已绑定目标商户且 payoutEnable=true，但正式 API 返回 channelStatus=unverified、channelVerifiedAt=NULL。** 已登录后台可见账户；按 [Waffo 官方流程](https://docs.waffo.ai/merchant/payout-accounts)，新账户在首笔真实提款核对收款人后才标为 Verified。当前状态可能与尚无真实提款有关，不凭此字段认定配置错误；无需重复新增账户。真实付款、账单和到账尚未验证。

## 此前的正式收费发布门槛（历史）

| 门槛 | 下一步与负责人 |
| --- | --- |
| 精确发行候选 | 最新 c93c9080 四平台 CI、Windows Node24/包内 Node22 全量、984 文件/109 嵌入源码/hash/四项密钥扫描、30 原生窗口及 55 包内专项通过。PR 安全门禁在逐条判定后通过，14 条主干已有告警保持 open 需各自审查；排行榜错误输出源码/实际构建回归及自动关闭已通过，但正式函数尚未替换；真实资金、恢复、受保护前端和原生生命周期仍未通过。后续源码改变须重新按来源核对，正式发行走统一 npm/macOS/Windows/Linux 流程 |
| Windows 设备路径 | 普通账号切换、退出/刷新已通过；成功礼遇兑换显示仍待验证；专用干净设备完成完整托盘入口、协议返回、安装/升级/卸载及数据保留。窗口测试与安装器编译不能代替生命周期 |
| 完整正式返回页 | 工程将受审的 Dashboard /billing/checkout 部署至正式 HTTPS 站点，并验证来源、账单归属、失焦/重开恢复；c93c9080 的 [Vercel Preview](https://dashboard-bdtmuqdm2-sunxiufeng1992-8555s-projects.vercel.app)（deployment 6969570061） 部署读回 success，但四个账单/法律路由均跳转 Vercel Login，浏览器亦无 Vercel 登录会话。需要 Owner 提供正常预览访问后验收；登录页 HTTP200 不算应用通过，现有 QA 静态页不算完整生产 Dashboard |
| 托管访问与恢复 | 工程在保持 preview 的前提完成其他正式函数部署顺序、免费/过渡/设备/导出回归及隔离备份恢复；归档未通过独立门槛时继续关闭 |
| 真实资金 | Owner 确定试点可用付款方式与金额上限并实际付款/系统确认；工程核对签名回调、订单、账本、完整月/年账期、拒付重试、取消和退款。不得把沙盒或手工造账当作真实交易 |
| 渠道与结算 | Owner 核对合同费率/币种/结算条件，真实收入满足提款条件后完成首笔提款并核对状态及到账；unverified 本身不证明配置错误。工程保存脱敏状态证据，失败或异常时再核对 Waffo 渠道 |
| 条款与启用 | Owner 确认退款/续费/隐私/客服政策和启用时间；工程准备具体文案、部署与回滚结果后再实施收费、公告和公开发行 |

自动审批审核此前拒绝完整托盘 Program.Main/单实例/Job Object 的额外测试，以及本机安装 Inno 的动作，均仅返回 blocked by policy；未执行或改工具绕过。另一次本机旧测试输出的递归清理也被拒绝，已保留旧目录并使用新的干净目录。CI 使用已安装的 Inno 编译器完成构建。工具拒绝的外部协议点击仍由本人在设备上完成。

此前各 checkpoint 的“CodeQL 通过”描述扫描 workflow 的执行结果，不作为当前 PR 安全告警清零证明。

## Owner 当前事项

正式价格、启用和一笔真实固定月付/全额退款均已完成，无需重复确认或再支付同一测试。剩余本人事项为真实收入满足合同条件后核对首笔提款/到账，以及提供 Windows 测试电脑接续 OS/完整入口、安装生命周期和新导出验收。工程负责新 UX、其余收费模式的范围审查及设备结果，统一桌面发行与公告另按其范围执行。当前 unverified 不单独证明结算配置错误。正式网站、Vercel 登录、隔离数据库恢复和正式函数替换已完成，无需新服务器或重复设置密钥、价格、产品及提款账户。live 后台为 active；供应商退款成功不代称实际支付账户或商户提款到账。

## 文档入口

[Cloud 交付](cloud-delivery.md)、[收款运维](cloud-billing-operations.md)、[Waffo 生产准备](waffo-production-readiness.md)、[Windows 验收](windows-cloud-acceptance.md)、[原生沙盒手册](native-sandbox-gateway-runbook.md)、[赠送码](pro-gift-codes.md)、[自部署](self-hosting-status.md)、[归档](cloud-usage-archive.md)、[规格](cloud-subscriptions.md)、[中文指南](cloud-guide.zh-CN.md)、[公告草稿](cloud-announcement-draft.md)。历史证据保留其注明的 SHA/环境，不升级为最新证据。
