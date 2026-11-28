import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

export function deployedCalculator(archive, name) {
  const src = readFileSync(
    join(archive, "tokentracker-" + name + ".ts"),
    "utf8",
  );

  const code = src
    .slice(0, src.lastIndexOf("\nexport {"))
    .replace(/^import .*?;$/gm, "");
  const calculate = runInNewContext(
    code + "\n;computeRowCost",
    {
      Deno: { env: { get: () => undefined } },
      TextEncoder,
      TextDecoder,
      URL,
      atob,
      btoa,
      Response,
      Request,
    },
    { timeout: 3000, contextCodeGeneration: { strings: false, wasm: false } },
  );
  return { src, calculate };
}
