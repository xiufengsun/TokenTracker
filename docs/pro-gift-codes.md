# Cloud 赠送码

2026-10-11 当前公开版本为 TokenTracker Cloud（云服务）1.3.3，发行 tag/source 为 `cc934784`。main/CLI/六项桌面资产/正式网站已发布，价格和既有权益标识不变。最新文件、hash、证明与剩余人工/资金验收见[发行总表](cloud-release-readiness.md)。下文原有 Pro 名称、旧源码和 QA 结果是历史记录，保留原始范围，不替代当前安装包的人工验收。

2026-10-10 正式网页与价格已启用，live policy 为 active；当前紧凑胶囊应用源码为 `1.3.2 / 39208a10`，正式 handler 按受审 `9c19419c` 产物替换。固定月期真实付款和全额退款已通过；新版真实浏览器使用专用 QA 完成一次 live 赠送兑换、Pro 标识生效及撤回，批次已停用、该 QA 没有付款。精确来源和范围见 [总表](cloud-release-readiness.md)、[交易验收](cloud-live-payment-acceptance.md)和 [UX 验收](cloud-pro-ux-acceptance.md)。这些网页、Mac QA 和 API 结果不证明 Windows 完整 GUI 兑换、普通非 QA 原生 OAuth OS 返回或实际结算；下文 Windows/Mac 礼遇记录保留各自原始来源。

Windows 管理员的原码生成/resume 及私有文件入口仍 unsupported、fail-closed，因为 owner-only NTFS ACL 尚未验证。它是可选能力，可由已验证的 Mac/Linux 管理程序发码，不是必须由 Owner 完成的正式收费门槛；应用内兑换不受影响。新 Cloud 用量 CSV/JSON 的普通 Downloads 保存也不证明私有码文件 ACL。以下已删除的 Windows A/B 是此前账号，不是本轮仍仅在 RAM 保管凭据的两个隔离 QA 账号。

2026-10-10 Windows 接续：gift 远端源码与当前构建完全一致，四个基础表 RLS 开启，管理 RPC 的匿名/客户端执行权限拒绝。两个专用真实 auth 账号完成 16 项 API 验证，包括无效码不授予权益、刷新轮换与本人隔离。Windows 普通账号 UI 登录/退出/重载/切换已完成 7 项验证；专用 A/B 账号在验收后删除、密码失效，原有白名单保留。该结果不是成功 Windows GUI 兑换证明；Windows 原码生成的 NTFS 守卫没有放宽。最新候选和证据见 [总表](cloud-release-readiness.md)。

赠送码由 TokenTracker 后端发放会员权益。Waffo 继续处理付费订阅，赠送不创建订单、付款或自动续费。

2026-10-09 交接核对：以下真实网页、数据库和源码绑定结果属于 `77ca2024` 的赠送阶段。本轮源码与平台回归以 [上线前交接总表](cloud-release-readiness.md) 为准；后续主干整合不会使旧测试包自动包含新源码。上线前在受审的生产 preview 产物复核 gift RPC 权限、账号隔离、礼遇/付款互斥与撤回显示，保留私有码文件，禁止把停用批次当作撤回已领取权益。

## 用户体验

账户中的云服务区提供“兑换云服务码”入口。用户登录后输入兑换码，服务端核验并绑定账号；每个码只能领取一次，同一账号重试不会重复加时。可赠送30、90或365天，所有日期以服务端为准。领取记录与付款记录分别显示，赠送用户拥有完整 Cloud 服务访问权限和标识。

自动续费未关闭或仍有待处理付款时，兑换不会消耗码。用户先处理现有订阅或订单，再领取。固定期会员、已关闭续费的会员在当前已付权益结束后接续赠送期。礼遇期间暂不创建新的付费订单，避免付费期与赠送期重叠。未来礼遇的既定日期不会随付款退款改写，赠送也不会改变供应商的扣款日。

码的领取截止时间与领取后的会员期限分别管理。批次停用只阻止尚未领取的码；撤回已经领取的权益是另一项明确管理操作。到期后回到免费社区权限，完整本地功能和记录保留。

## 私有管理

管理命令使用现有InsForge的服务端凭据，不在网页暴露管理员密钥。环境必须明确指定。原码只写一次到私有JSON文件，数据库仅保存哈希；命令输出只包含批次、数量和文件路径。不要把原码文件、管理员配置或服务密钥加入仓库。

原码生成和断线恢复使用已经验证的macOS/Linux私有文件权限。Windows的NTFS私有ACL尚未验证，因此这两项管理操作暂时关闭；Windows用户在应用内兑换不受影响。其他管理查询可通过服务端环境凭据运行，Windows不读取未经验证ACL的管理员配置文件。生成文件前需要Git检查；Git缺失或检查失败会拒绝写入，仓库内文件必须被ignore。

```sh
node scripts/pro-gift-codes.cjs generate --environment sandbox \
  --project-file /absolute/private/.insforge/project.json \
  --days 30 --count 10 --expires 2026-12-01T00:00:00Z \
  --label contributors --out /absolute/private/contributor-codes.json
```

网络超时后复用已经保存的文件，命令会提交同一个批次及哈希集合。

```sh
node scripts/pro-gift-codes.cjs generate --environment sandbox \
  --project-file /absolute/private/.insforge/project.json \
  --resume /absolute/private/contributor-codes.json
```

`list`查看最近最多100个批次，`codes --batch UUID`查看该批次最多1000个领取记录和码尾号，`disable --batch UUID`停用未领取码，`revoke --grant UUID`撤回单个已领取权益。每条命令都需要同样的环境与私有配置参数。也可通过`INSFORGE_BASE_URL`、`INSFORGE_SERVICE_ROLE_KEY`传入服务端配置。

2026-10-10 正式网页购买已按 Owner 授权启用，正式赠送 handler 已部署并核对来源；本轮没有向真实用户批量发码，正式赠送记录仍为 0。发码须明确选 live 环境和目标批次，不复制沙盒码。自部署保持免费，不显示官方兑换入口；下面验收记录只证明其注明的沙盒账号、环境与源码，不冒称正式发码或 Windows GUI 已验收。

## 验收记录

2026-10-09，代码提交`77ca20241d0f6d0830acdbbb720e3bf078591dc2`。迁移已应用到现有付费InsForge，独立读取确认四张赠送表存在，普通用户不能直接读码表或调用管理RPC。专用`tokentracker-billing-gifts-sandbox`只接受两个受控账号的登录、账户查询和兑换，不开放付款操作，远端源码与审核产物一致。

真实批量生成6个30天测试码，使用保存文件重复提交后仍为同一批次。两个账号经正常登录表单各领取一个码；重复领取不增加天数，其他账号领取同一码及无效码均被拒绝。页面刷新恢复原权益，切换账号不显示前一个账号的赠送记录。停用批次后，已领取权益保留，未领取码被拒绝；单独撤回一个账号的权益后，页面显示撤回记录与历史导出宽限期。测试码不会用于真实用户。

PostgreSQL15.18的两个独立连接验证了一码两账号只有一个领取成功，同账号不同码连续接续。全仓3846项通过、3项跳过及4项架构检查通过；前端1169项、136个文件通过。Mac与Windows测试包均重新构建并绑定877个源码blob，私有凭据和原码扫描零匹配。Windows实机的新兑换路径仍需按[客户端交接](windows-cloud-acceptance.md)验证。

真实网页已检查浅色、深色、390px和1280px的布局、表单标签、键盘提交及焦点，无横向溢出。用户允许接续同一Ego测试空间后，两个账号分别通过正常退出操作得到HTTP200，服务端账号状态为空。重载后仍未登录，刷新请求返回401，赠送记录和兑换入口保持隐藏，没有通过清理浏览器存储或代清服务端会话完成验证。

此前截图超时。显示已有测试空间后，视口截图成功，已审查桌面1280px和手机390px的浅深色兑换表单、赠送期限和记录，以及退出后的画面。全页截图仍超时，不作为验收证据。原生GUI、安装器和浏览器唤起App不由这些网页检查替代。
