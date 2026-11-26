# TokenTracker 验证邮件发信域

2026-11-24 已在目标账号建立 `tokentracker.cc` 免费 zone。经负责人单独授权，已在阿里云完成 NS 更换。四台 .cc 注册局服务器均读回 josh.ns.cloudflare.com 和 sureena.ns.cloudflare.com。Cloudflare 于 2026-11-24 08:52:54 UTC 激活该 zone，1.1.1.1 与 8.8.8.8 都返回新 NS。

阿里云导出的五条记录均已在 Cloudflare 录入。两端四台权威服务器分别回答五次查询，20/20 的域名、类型、值和 600 秒 TTL 全部一致。Cloudflare 中的 A 和 CNAME 均为 DNS only。注册局查询未返回 DS。切换后主域返回 307 跳到 www，www 返回 Vercel 200。

已开通的发件地址为 `auth@mail.tokentracker.cc`。Cloudflare Email Sending 已创建该子域的六条记录，API 回读 enabled=true、DNS status=ready、errors 为空。完整值见 [生效记录](./mail.tokentracker.cc-dns.json)。其中三条 MX 用于退信，另外三条 TXT 分别用于 SPF、DKIM 和 DMARC。两台 Cloudflare 权威 NS 返回相同的三条 MX，优先级依次为 route1=63、route2=7、route3=36。

QA Worker 已配置该发件地址和 EMAIL binding。08:52 UTC 完成 NS 激活，09:02 UTC Cloudflare 计入一封 Gmail 测试邮件。09:07 UTC 收件人提供验证码后，QA 成功换取重置凭据、设置新密码并登录原 QA 账号。验证码与重置凭据各重放一次都返回 401，原密码、原 access token 被拒绝；新会话退出后也返回 401。

[现网五条记录](./tokentracker.cc-dns-baseline.txt) · [Cloudflare 发信域文档](https://developers.cloudflare.com/email-service/configuration/domains/)
