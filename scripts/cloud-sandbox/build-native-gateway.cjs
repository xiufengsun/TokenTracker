const fs = require("node:fs/promises");
const path = require("node:path");
const { build } = require("esbuild");
const ROOT = path.resolve(__dirname, "../..");
async function buildNativeGateway(directory = path.join(ROOT, ".tmp/cloud-functions-native-gateway")) {
  await fs.mkdir(directory, { recursive: true });
  const slug = "tokentracker-native-sandbox-gateway";
  await build({ entryPoints: [path.join(__dirname, "native-gateway.ts")], bundle: true, format: "esm", platform: "neutral", target: "es2022",
    outfile: path.join(directory, slug + ".js"), external: ["npm:@insforge/sdk@1.4.5"], logLevel: "silent" });
  return { directory, slug, file: path.join(directory, slug + ".js") };
}
if (require.main === module) buildNativeGateway(process.argv[2] ? path.resolve(process.argv[2]) : undefined)
  .then(value => console.log(`Built ${value.slug} in ${value.directory}`)).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { buildNativeGateway };
