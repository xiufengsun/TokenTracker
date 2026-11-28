# 跨设备继续 TokenTracker 后端迁移

在另一台设备上，用有权访问私库的 GitHub 账号克隆并切到工作分支：

```sh
gh repo clone xiufengsun/TokenTracker-private -- --branch feat/cloudflare-migration
cd TokenTracker-private
```

私库的 main 以公开仓库的 432156a1（v1.5.27）为本次迁移基线。代码入口是 [Worker](../worker/src/index.ts) 和 [D1 迁移](../migrations/)。本地 Worker 测试使用合成数据，可按仓库中 [package.json](../worker/package.json) 的 Node 版本运行：

```sh
cd cloudflare/worker
npm ci
npm run typecheck
npm test
```

## 已验证

- GitHub、Google、邮箱密码及验证码找回，含单次兑换、刷新、退出和 macOS 系统浏览器回到 App。桌面完成页已恢复绿色对号，备用按钮在中英文均有验证。[登录与客户端](./auth-and-clients-2026-11-24.md) · [桌面端](./desktop-clients.md)
- Waffo 沙盒的月付、年付、模拟续期、取消和退款，已核对供应商签名回调。设备上传及账单成本口径已与 v1.5.27 对齐。[支付](./billing-2026-11-24.md) · [成本证据](./cost-coverage-2026-11-24.md) · [HTTPS 压力验收](./https-load-2026-11-24.md)
- tokentracker.cc 权威 DNS 已在 Cloudflare 激活，网站由 Vercel 提供。邮件发送域及 Gmail 收件完成验证。[DNS 与发信](./email-dns.md)

## 待继续

1. 数据导入、导出、上传、下载和自动续传已由负责人暂停。原机最后确认第 142 个分片。断点属于旧版数据结构，之后加入了 0043 成本证据迁移。恢复前先核对镜像与版本，以及 [一致快照](./consistent-source-export.md)、[全量校验](./d1-full-transfer.md) 和 [增量追平](./snapshot-delta.md)。备份、数据库和密钥留在原机，另外登录私库只会取得代码和文档。
2. Windows 和 Linux 原生安装、登录及系统回调，等待负责人提供测试机。
3. 生产云后端仍在 InsForge。正式发布、切流及生产支付回调变更须按 [切换顺序](./cutover.md) 单独确认。
