# Cloudflare 成本证据 v1 验收

对应 TokenTracker 432156a1（#1158）。2026-11-24 从 InsForge 函数控制面取得当前已部署源码。上传入口已支持版本探测和写入确认。五个成本读取函数均已使用成本证据。账户与公开榜单实际部署的模型价表版本仍有差异，Worker 继续使用对应入口的价格。以下验证采用合成记录。

| 函数 | 部署源码 SHA-256 前 12 位 | 验证 |
|---|---|---|
| ingest | e8be27732dbe | 真实 CLI 队列的探测、写入确认、偏移量 |
| account-summary | 3158468abf75 | 226 组输入 |
| account-daily | e13fdec9bfe3 | 226 组输入 |
| account-model-breakdown | 4a6c032c45d9 | 226 组输入及来源标签 |
| leaderboard-profile | 9958fa6f61a4 | 226 组输入 |
| leaderboard-refresh | 877ebf6eeb49 | 226 组输入及 D1 SQL 的榜单金额 |

- 从各份部署源码提取纯计算函数，逐一对比 Worker。1,130 组合成输入的金额均一致，覆盖 Grok、Cursor、Cline、Codex 和其他来源的已知、未知、免费及 Batch/Flex SKU，明确的零、全覆盖、未覆盖、部分覆盖与分摊。
- 将 0043 及 Worker 部署于独立合成 QA 预览 e72c7a7c。通过真实 drainQueueToCloud 从私有临时队列上传 5 条合成记录。版本探测与写入 ACK 后队列偏移量到达文件末尾。日、汇总、公开个人资料及周榜相比上传前均增加 $2.40，模型明细的 mixed、provider_reported、allocated、unpriced 标签和分摊标志匹配。上传带额外字段的证据返回 400。
- 本地 workerd 验收包括等量纠正到零、重复重放、无证据旧客户端、未授权探测、跨日同价格维度的来源合并、设备合并保留证据、等排名冲突失败、历史聚合缺列时按原 token 向量核对后补证据。无法匹配向量时保留旧榜单，拒绝用不一致的费用发布新排名。
- Worker 整合测试 35/35 通过，TypeScript 检查通过。上游 #1158 的定价、证据、云端 E2E 与上传协商测试 42/42 通过。远端预览未写入实际客户数据。本文未验证全量大库的迁移、回填成本或新版刷新耗时。
