const fs = require("node:fs/promises");
const path = require("node:path");
const REALM = "tokentracker-native-sandbox-v1";
async function buildNativeReturnSite(directory) {
  if (!directory) throw Error("An independent sandbox source directory is required");
  await fs.mkdir(path.join(directory, "public"), { recursive: true });
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow,noarchive"><meta name="referrer" content="no-referrer"><title>Return to TokenTracker QA</title>
<link rel="stylesheet" href="/return.css"><script src="/return.js" defer></script></head>
<body><main><p class="label">TokenTracker QA</p><h1>Check your order in the app</h1>
<p>This page does not confirm a payment. Return to the test app to check your order with its signed-in account.</p>
<a id="return-link" hidden>Return to TokenTracker QA</a><p id="invalid" role="status">Open this page from a test checkout with an order reference.</p></main></body></html>`;
  const script = `'use strict';
const params=new URLSearchParams(window.location.search),order=params.get('order');
if(window.location.pathname==='/billing/checkout'&&params.getAll('order').length===1&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(order||'')){
 const link=document.getElementById('return-link');
 link.href='tokentracker-qa://billing/return?order='+encodeURIComponent(order)+'&realm='+encodeURIComponent(${JSON.stringify(REALM)});
 link.hidden=false;document.getElementById('invalid').hidden=true;
}
`;
  await fs.writeFile(path.join(directory, "public/index.html"), html);
  await fs.writeFile(path.join(directory, "public/return.js"), script);
  await fs.writeFile(path.join(directory, "public/return.css"), "*{box-sizing:border-box}body{margin:0;background:#f7f7f7;color:#242424;font:16px/1.6 system-ui,sans-serif}main{max-width:38rem;margin:12vh auto;padding:2rem}.label{color:#737373;font-size:13px}h1{font-size:28px;line-height:1.2}a{display:inline-block;color:#242424;padding:12px 18px;border:1px solid #a3a3a3;border-radius:8px;text-decoration:none}a:hover{background:#e5e5e5}a:focus-visible{outline:2px solid #404040;outline-offset:3px}[hidden]{display:none}@media(prefers-color-scheme:dark){body{background:#171717;color:#e5e5e5}a{color:#e5e5e5;border-color:#737373}a:hover{background:#262626}}\n");
  await fs.writeFile(path.join(directory, "package.json"), JSON.stringify({ name: "tokentracker-native-sandbox-return", version: "0.0.0", private: true,
    scripts: { build: "node build.cjs" } }, null, 2) + "\n");
  await fs.writeFile(path.join(directory, "build.cjs"), "const fs=require('node:fs');fs.mkdirSync('dist',{recursive:true});fs.cpSync('public','dist',{recursive:true});\n");
  await fs.writeFile(path.join(directory, "vercel.json"), JSON.stringify({ version: 2, outputDirectory: "dist", buildCommand: "npm run build",
    rewrites: [{ source: "/billing/checkout", destination: "/index.html" }], headers: [{ source: "/(.*)", headers: [
      { key: "Cache-Control", value: "no-store" }, { key: "X-Content-Type-Options", value: "nosniff" }, { key: "Referrer-Policy", value: "no-referrer" },
      { key: "Content-Security-Policy", value: "default-src 'none'; script-src 'self'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'" },
      { key: "X-Robots-Tag", value: "noindex,nofollow,noarchive" } ] }] }, null, 2) + "\n");
  return directory;
}
if (require.main === module) buildNativeReturnSite(process.argv[2] && path.resolve(process.argv[2]))
  .then(directory => console.log(`Built independent return-site source in ${directory}`)).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { buildNativeReturnSite };
