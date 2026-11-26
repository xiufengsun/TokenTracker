import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import schema from "../../migrations/0001_community_snapshot.sql?raw";

it("serves the public snapshot payload intact through the old function routes", async () => {
  await env.DB.prepare(schema).run();
  const url = "https://test.local/functions/tokentracker-community-models";
  const empty = await SELF.fetch(url);
  expect(empty.status).toBe(503);
  expect(empty.headers.get("Retry-After")).toBe("30");

  const generated = "2026-11-24T03:17:00.079627+00:00";
  const payload = '{"period":"total","generated_at":"' + generated + '","total_tokens":9007199254740993}';
  await env.DB.prepare("INSERT INTO community_snapshot VALUES ('total', ?, ?)").bind(generated, payload).run();
  for (const route of [url, url.replace("/functions/", "/")]) {
    const response = await SELF.fetch(route);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(payload);
    expect(response.headers.get("X-Community-Stats-Source")).toBe("snapshot");
  }
  expect((await SELF.fetch(url, { method: "OPTIONS" })).status).toBe(204);
  expect((await SELF.fetch(url, { method: "POST" })).status).toBe(405);
  expect((await SELF.fetch("https://test.local/")).status).toBe(404);
});
