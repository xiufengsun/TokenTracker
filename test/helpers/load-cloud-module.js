const path = require("node:path");
const Module = require("node:module");
const { buildSync } = require("esbuild");

module.exports = function loadCloudModule(name) {
  const filename = path.resolve(__dirname, "../../dashboard/edge-patches/cloud", `${name}.ts`);
  const output = buildSync({ entryPoints: [filename], bundle: true, write: false,
    format: "cjs", platform: "node", target: "node20", logLevel: "silent",
    alias: { "npm:alipay-sdk@4.14.0": require.resolve("alipay-sdk"),
      "npm:@waffo/pancake-ts@0.25.0": require.resolve("@waffo/pancake-ts"),
      "npm:@insforge/sdk@1.4.5":path.join(path.dirname(require.resolve("@insforge/sdk",{paths:[path.resolve(__dirname,"../../dashboard")]})),"index.mjs") } });
  const compiled = new Module(filename, module);
  compiled.filename = filename;
  compiled.paths = Module._nodeModulePaths(path.dirname(filename));
  compiled._compile(output.outputFiles[0].text, filename);
  return compiled.exports;
};
