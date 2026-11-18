// Component-only fixture server: deliberately excludes the app's local-data API plugin.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { copyRegistryPlugin } from "../scripts/copy-registry-plugin.mjs";

export default defineConfig({
  root: fileURLToPath(new URL("..", import.meta.url)),
  plugins: [react(), copyRegistryPlugin()],
  server: { host: "127.0.0.1", port: 5194, strictPort: true, hmr: false },
});
