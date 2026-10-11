const fs = require("node:fs/promises");
const path = require("node:path");
const { build } = require("esbuild");
const { builtinModules } = require("node:module");
const { sandboxEnvironmentBanner, accessEnvironmentBanner } = require("./cloud-sandbox/environment.cjs");

const ROOT = path.resolve(__dirname, "..");
const FUNCTIONS = [
  "tokentracker-billing", "tokentracker-waffo-webhook", "tokentracker-paddle-webhook", "tokentracker-wechat-webhook", "tokentracker-alipay-webhook",
  "tokentracker-device-token-issue", "tokentracker-device-flow-grant", "tokentracker-device-flow-poll", "tokentracker-ingest",
  "tokentracker-account-summary", "tokentracker-account-daily", "tokentracker-account-hourly", "tokentracker-account-monthly",
  "tokentracker-account-heatmap", "tokentracker-account-model-breakdown", "tokentracker-account-devices",
  "tokentracker-leaderboard", "tokentracker-leaderboard-profile",
];
const ACCESS_FUNCTIONS = [
  { name: "tokentracker-device-token-issue", kind: "user" },
  { name: "tokentracker-ingest", kind: "ingest" },
  ...["summary", "daily", "hourly", "monthly", "heatmap", "model-breakdown", "devices"]
    .map(name => ({ name: "tokentracker-account-" + name, kind: "user" })),
  { name: "tokentracker-device-rename", kind: "user" },
  { name: "tokentracker-device-flow-authorize", kind: "authorize" },
  { name: "tokentracker-device-flow-grant", kind: "user" },
  { name: "tokentracker-device-flow-poll", kind: "poll" },
  { name: "tokentracker-billing-access", source: "tokentracker-billing", kind: "management" },
];

async function buildCloudFunctions({ sandbox = false, accessSandbox = false, giftSandbox = false } = {}) {
  if ([sandbox, accessSandbox, giftSandbox].filter(Boolean).length > 1) throw new Error("Choose one sandbox build target");
  const output = path.join(ROOT, giftSandbox ? ".tmp/cloud-functions-gift-sandbox" : accessSandbox ? ".tmp/cloud-functions-access-sandbox" : sandbox ? ".tmp/cloud-functions-sandbox" : ".tmp/cloud-functions");
  await fs.mkdir(output, { recursive: true });
  const lock=JSON.parse(await fs.readFile(path.join(ROOT,"package-lock.json"),"utf8"));
  const sdkRoot=path.join(ROOT,"node_modules/alipay-sdk");
  const sdk=JSON.parse(await fs.readFile(path.join(sdkRoot,"package.json"),"utf8"));
  const sdkLicense=await fs.readFile(path.join(sdkRoot,"LICENSE.txt"),"utf8");
  if(sdk.version !== "4.14.0" || lock.packages["node_modules/urllib"]?.version !== "4.9.1") {
    throw new Error("Cloud builds require Alipay SDK 4.14.0 and patched urllib 4.9.1");
  }
  const waffoRoot = path.join(ROOT, "node_modules/@waffo/pancake-ts");
  const waffoLicense = sandbox || giftSandbox ? await fs.readFile(path.join(waffoRoot, "LICENSE"), "utf8") : "";
  if ((sandbox || giftSandbox) && (JSON.parse(await fs.readFile(path.join(waffoRoot, "package.json"), "utf8")).version !== "0.25.0" ||
    lock.packages["node_modules/@waffo/pancake-ts"]?.version !== "0.25.0")) {
    throw new Error("Sandbox builds require Waffo SDK 0.25.0");
  }
  // Embed the official SDK, pinning its direct runtime imports to the reviewed
  // lockfile. A fresh Deno resolution of the SDK's ^4 range selected urllib 4.9.0.
  const paymentDependencies={name:"locked-payment-runtime",setup(build){
    build.onResolve({filter:/^npm:/},args=>args.path === "npm:alipay-sdk@4.14.0"
      ? {path:path.join(sdkRoot,"dist/esm/index.js")}
      : (sandbox || giftSandbox) && args.path === "npm:@waffo/pancake-ts@0.25.0"
      ? {path:path.join(waffoRoot,"dist/index.js")}
      : {path:args.path,external:true});
    build.onResolve({filter:/^[^./]/},args=>{
      const alipayImport = args.importer.startsWith(sdkRoot+path.sep);
      if(!alipayImport && !((sandbox || giftSandbox) && args.importer.startsWith(waffoRoot+path.sep)))return;
      const name=args.path.startsWith("@") ? args.path.split("/").slice(0,2).join("/") : args.path.split("/")[0];
      if(args.path.startsWith("node:") || builtinModules.includes(args.path))return {path:args.path.startsWith("node:")?args.path:"node:"+args.path,external:true};
      const version=lock.packages["node_modules/"+name]?.version;
      if(!alipayImport || !sdk.dependencies[name] || !version)throw new Error("Unreviewed payment runtime dependency: "+name);
      return {path:"npm:"+name+"@"+version+args.path.slice(name.length),external:true};
    });
  }};
  const qaSdkPath = path.join(ROOT, "scripts/cloud-sandbox/qa-sdk.ts");
  const qaSdk = { name: "qa-sdk-routing", setup(builder) {
    builder.onResolve({ filter: /^npm:@insforge\/sdk(?:@1\.4\.5)?$/ }, args =>
      args.importer === qaSdkPath ? { path: "npm:@insforge/sdk@1.4.5", external: true } : { path: qaSdkPath });
  } };
  const functions = giftSandbox ? ["tokentracker-billing-gifts"] : accessSandbox ? ACCESS_FUNCTIONS.map(item => item.name) : sandbox ? ["tokentracker-billing", "tokentracker-waffo-webhook"] : FUNCTIONS;
  for (const name of functions) {
    const target = accessSandbox ? ACCESS_FUNCTIONS.find(item => item.name === name) : null;
    const sourceName = giftSandbox ? "tokentracker-billing" : target?.source || name;
    const banner = [];
    if (["tokentracker-billing","tokentracker-alipay-webhook"].includes(sourceName)) {
      banner.push('import { Buffer } from "node:buffer";\n/*! Alipay SDK 4.14.0\n'+sdkLicense.replace(/\*\//g,"* /")+'*/');
    }
    if (sandbox || giftSandbox) banner.push(sandboxEnvironmentBanner,
      'const tokentrackerSandboxWebhookKey = tokentrackerSandboxEnv("WAFFO_WEBHOOK_TEST_PUBLIC_KEY");',
      '/*! Waffo SDK 0.25.0\n' + waffoLicense.replace(/\*\//g,"* /") + '*/');
    if (accessSandbox) banner.push(accessEnvironmentBanner);
    await build({ ...(accessSandbox ? { stdin: {
      contents: `import original from ${JSON.stringify(path.join(ROOT, "dashboard/edge-patches", sourceName + ".ts"))};\n` +
        `import { guardAccess } from ${JSON.stringify(path.join(ROOT, "scripts/cloud-sandbox/access.ts"))};\n` +
        `export default guardAccess(original, ${JSON.stringify(target.kind)});`,
      resolveDir: ROOT, sourcefile: `qa-entry/${name}.ts`, loader: "ts",
    } } : { entryPoints: [giftSandbox ? path.join(ROOT, "scripts/cloud-sandbox/gifts.ts") : sandbox && name === "tokentracker-billing"
      ? path.join(ROOT, "scripts/cloud-sandbox/billing.ts")
      : path.join(ROOT, "dashboard/edge-patches", `${name}.ts`)] }),
      outfile: path.join(output, `${name}${sandbox || accessSandbox || giftSandbox ? "-sandbox" : ""}.js`), bundle: true, format: "esm", platform: "neutral",
      ...(banner.length ? { banner: { js: banner.join("\n") } } : {}),
      ...(sandbox || giftSandbox ? { define: { "Deno.env.get": "tokentrackerSandboxEnv",
        "process.env.WAFFO_WEBHOOK_TEST_PUBLIC_KEY": "tokentrackerSandboxWebhookKey",
        "process.env.WAFFO_WEBHOOK_PROD_PUBLIC_KEY": "undefined",
        "process.env.WAFFO_WEBHOOK_PUBLIC_KEY": "undefined" } } : {}),
      ...(accessSandbox ? { define: { "Deno.env.get": "tokentrackerQaAccessEnv" } } : {}),
      target: "es2022",plugins:accessSandbox ? [qaSdk,paymentDependencies] : [paymentDependencies],logLevel:"silent" });
  }
  return { output, functions: functions.map(name => name + (sandbox || accessSandbox || giftSandbox ? "-sandbox" : "")) };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.some(arg => !["--sandbox", "--access-sandbox", "--gift-sandbox"].includes(arg)) || args.length > 1) {
    console.error("Usage: node scripts/build-cloud-functions.cjs [--sandbox | --access-sandbox | --gift-sandbox]");
    process.exitCode = 1;
  } else {
    buildCloudFunctions({ sandbox: args.includes("--sandbox"), accessSandbox: args.includes("--access-sandbox"), giftSandbox: args.includes("--gift-sandbox") })
      .then(({ output, functions }) => console.log(`Built ${functions.length} Cloud edge functions in ${output}`))
      .catch(error => { console.error(error.message); process.exitCode = 1; });
  }
}
module.exports = { buildCloudFunctions };
