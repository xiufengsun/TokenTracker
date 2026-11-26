import { nativeReturnDefine } from "./native-return-copy.mjs";
import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";
const waffoSdk = { "npm:@waffo/pancake-ts@0.25.0": new URL("./node_modules/@waffo/pancake-ts/dist/index.js", import.meta.url).pathname };
export default defineConfig({ define: nativeReturnDefine, resolve: { alias: waffoSdk }, plugins: [cloudflare()] });
