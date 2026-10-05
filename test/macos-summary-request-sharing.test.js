"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawnSync, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { test } = require("node:test");
const run = promisify(execFile);
const swiftAvailable = spawnSync("swiftc", ["--version"], { stdio: "ignore" }).status === 0;

test("macOS production summary single flight makes one HTTP request per date range", { skip: !swiftAvailable }, async (t) => {
  const viewModel = fs.readFileSync(path.join(__dirname, "../TokenTrackerBar/TokenTrackerBar/ViewModels/DashboardViewModel.swift"), "utf8");
  const helper = viewModel.match(/        var summaryRequests: \[String: Task<UsageSummaryFetchResult, Error>\] = \[:\][\s\S]*?\n        }/);
  assert.ok(helper, "execute the helper used by the production loadAll path");
  const fullLoad = viewModel.slice(viewModel.indexOf("func loadAll()"), viewModel.indexOf("private func finishDataLoad"));
  assert.ok(!/fetchSummary(?:WithSource)?\([^)]*from: rollingFrom,/.test(fullLoad), "rolling cards reuse today's summary instead of a separate summary fetch");
  const counts = new Map();
  const server = http.createServer((req, res) => {
    const params = new URL(req.url, "http://localhost").searchParams;
    const key = `${params.get("from")}|${params.get("to")}`;
    counts.set(key, (counts.get(key) || 0) + 1);
    const value = params.get("from") === "2026-10-02" ? 100 : params.get("from") === "2026-10-01" ? 200 : 300;
    res.end(JSON.stringify({ value }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-summary-sharing-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const source = `
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
struct UsageSummaryFetchResult: Decodable { let value: Int }
@MainActor final class APIClient {
    static let shared = APIClient()
    func fetchSummaryWithSource(from: String, to: String) async throws -> UsageSummaryFetchResult {
        let url = URL(string: CommandLine.arguments[1] + "?from=" + from + "&to=" + to)!
        let (data, _) = try await URLSession.shared.data(from: url)
        return try JSONDecoder().decode(UsageSummaryFetchResult.self, from: data)
    }
}
@main struct Main {
    @MainActor static func main() async throws {
${helper[0]}
        let ranges = [("2026-10-02", "2026-10-02"), ("2026-10-02", "2026-10-02"), ("2026-10-01", "2026-10-02"), ("2023-10-03", "2026-10-02"), ("2023-10-03", "2026-10-02")]
        let values = try await withThrowingTaskGroup(of: Int.self) { group in
            for range in ranges {
                group.addTask { @MainActor in try await fetchSummary(from: range.0, to: range.1).value }
            }
            var values: [Int] = []
            for try await value in group { values.append(value) }
            return values.sorted()
        }
        print(values)
    }
}
`;
  const file = path.join(temp, "main.swift");
  const binary = path.join(temp, "summary-sharing");
  fs.writeFileSync(file, source);
  await run("swiftc", ["-parse-as-library", file, "-o", binary]);
  const { stdout } = await run(binary, [`http://127.0.0.1:${server.address().port}`]);
  assert.equal(stdout.trim(), "[100, 100, 200, 300, 300]");
  assert.equal(counts.size, 3);
  assert.deepEqual([...counts.values()], [1, 1, 1]);
});
