# 账号迁移和客户端验收

2026-11-24 在 Cloudflare 独立 QA 库验证。真实业务用量样本库和全量演练库均未用于处理这些公开登录请求。

| 验收路径 | 实测结果 |
|---|---|
| Google OAuth | 06:03:46 UTC 收到真实 Google 回调并返回预先绑定的 QA 账号 ID。单次 PKCE 换码、current user、refresh、退出吊销均通过。 |
| GitHub OAuth | 06:05:40 UTC 收到真实 GitHub 回调，同一套断言全部通过。Worker 对 GitHub 采用手动重定向模式、明确的表单类型和 User-Agent，拒绝非成功回复。并行登录各自有 state 绑定 cookie。 |
| 邮箱密码登录 | Chrome 158 在未签名 macOS arm64 Release 测试包的内嵌服务上完成登录、显示预期 ID、刷新保留会话、网页批准设备、退出、刷新后仍已退出。测试环境旧 InsForge 域请求为 0。 |
| 真实设备上传 | 内嵌 Node 22.22.2 运行实际 CLI，将原始 Codex 测试事件解析入队，sync --drain 后队列 offset 到达文件末尾。远端按同一个 device_id 查到 7,331 tokens。 |
| 邮箱收件 | Gmail 实际收到来自 auth@mail.tokentracker.cc 的 QA 验证码，成功恢复原 QA ID；验证码、重置凭据重放和旧会话均被拒绝。 |
| 兼容版本 | 已发布的桌面包仍含旧后端默认地址和认证代理。迁移版需一起发布 npm 与 macOS、Windows、Linux 包。独立 macOS QA App 已完成系统浏览器到 AppKit 再到 WKWebView 的真实 Google/GitHub 回调，两次均匹配原 QA ID 并成功退出。Windows、Linux 的原生 UI 待负责人提供测试机。 |

GitHub 和 Google 的 QA 验证使用专用测试身份，预先将有权使用的 provider subject 关联到隔离账号。生产共享身份的归属、密码哈希和冲突另外在加密的源快照上演练。四组邮箱仅大小写等规范化规则不同，迁移保留原 ID，冲突账号的邮件恢复转原登录方式或人工核实。QA Client Secret 与迁移密钥不进入仓库。

GitHub 的首轮真实回调失败，远端复现显示 Worker 请求供应商时使用的重定向选项导致请求失败，后续重复打开已消费的回调还会报状态失效。调整请求选项后重新完成真实授权。客户端另修复了本机浏览器 Origin 中继、响应解压头、zstd 协商、空 POST 和 refresh 后的 CSRF。以上验收记录使用修复后的版本。

桌面 OAuth 的系统浏览器现在显示绿色对号完成页，并自动打开 App；页面提供同一 PKCE 授权码的备用打开按钮。网页和 loopback 客户端继续返回原 HTTPS/HTTP 回调。GitHub 和 Google 的系统浏览器回调均实测唤起隔离的 macOS App，完成 PKCE 兑换并显示预期账号。Chrome 回读对号为绿色，按钮为圆角实心且没有下划线。QA 版本 904079d6 调整排版，Chrome 在英文桌面和中文窄屏下均测得标题 20px/600、说明 14px、按钮 13px/500，按钮点击高度 44px。
