import { nativeReturnDefine } from "./native-return-copy.mjs";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({ define: nativeReturnDefine,
	resolve: { alias: { "npm:@waffo/pancake-ts@0.25.0": new URL("./node_modules/@waffo/pancake-ts/dist/index.js", import.meta.url).pathname } },
	plugins: [cloudflareTest({ config: true })],
});
