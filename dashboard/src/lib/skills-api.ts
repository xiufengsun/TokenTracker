import { getLocalApiAuthHeaders } from "./local-api-auth";
import { isValidJwtShape } from "./auth-token";
import { getInsforgeAnonKey, getInsforgeRemoteUrl } from "./insforge-config";
import { buildSkillInventoryMetadata } from "./skills-inventory";

type AnyRecord = Record<string, any>;

const SLUG = "tokentracker-skills";
const CLOUD_SLUG = "tokentracker-account-skills";
const CLOUD_REQUEST_TIMEOUT_MS = 15_000;

async function fetchSkillsJson(params?: AnyRecord) {
  const url = new URL(`/functions/${SLUG}`, window.location.origin);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value != null && value !== "") url.searchParams.set(key, String(value));
    }
  }
  const response = await fetch(url.toString(), {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error || `Request failed with HTTP ${response.status}`);
  }
  return payload;
}

async function mutateSkillsJson(body: AnyRecord) {
  const authHeaders = await getLocalApiAuthHeaders();
  const response = await fetch(`/functions/${SLUG}`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...authHeaders,
    },
    cache: "no-store",
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.ok === false) {
    throw new Error(payload?.error || `Request failed with HTTP ${response.status}`);
  }
  return payload;
}

export function getInstalledSkills() {
  return fetchSkillsJson({ mode: "installed" });
}

export function discoverSkills(options: { force?: boolean } = {}) {
  return fetchSkillsJson({ mode: "discover", ...(options.force ? { force: 1 } : {}) });
}

export function searchSkills(query: string, offset = 0, limit = 20) {
  return fetchSkillsJson({ mode: "search", q: query, offset, limit });
}

export function getSkillRepos() {
  return fetchSkillsJson({ mode: "repos" });
}

export function installSkill(skill: AnyRecord, targets: string[]) {
  return mutateSkillsJson({ action: "install", skill, targets });
}

export function updateSkills(ids: string[]) {
  return mutateSkillsJson({ action: "update_all", ids });
}

export function uninstallSkill(id: string) {
  return mutateSkillsJson({ action: "uninstall", id });
}

export function restoreSkill(id: string) {
  return mutateSkillsJson({ action: "restore", id });
}

export function setSkillTargets(id: string, targets: string[]) {
  return mutateSkillsJson({ action: "set_targets", id, targets });
}

export function importLocalSkill(directory: string, targets: string[]) {
  return mutateSkillsJson({ action: "import_local", directory, targets });
}

export function deleteLocalSkill(directory: string, targets?: string[]) {
  return mutateSkillsJson({ action: "delete_local", directory, targets: targets || [] });
}

export function addSkillRepo(repo: AnyRecord) {
  return mutateSkillsJson({ action: "add_repo", repo });
}

export function removeSkillRepo(owner: string, name: string) {
  return mutateSkillsJson({ action: "remove_repo", owner, name });
}

export function getPopularSkills(options: { force?: boolean } = {}) {
  return fetchSkillsJson({ mode: "popular", ...(options.force ? { force: 1 } : {}) });
}

export function checkSkillUpdates(options: { force?: boolean } = {}) {
  return fetchSkillsJson({ mode: "updates", ...(options.force ? { force: 1 } : {}) });
}

export function getSkillActivity(limit = 50) {
  return fetchSkillsJson({ mode: "activity", limit });
}

export function getSkillUsage(options: { force?: boolean } = {}) {
  return fetchSkillsJson({ mode: "skill_usage", ...(options.force ? { force: 1 } : {}) });
}

async function fetchCloudSkillsJson({
  accessToken,
  method = "GET",
  body,
}: {
  accessToken: string;
  method?: "GET" | "POST";
  body?: unknown;
}) {
  if (!accessToken || !isValidJwtShape(accessToken)) throw new Error("Skills sync requires sign-in");
  const baseUrl = getInsforgeRemoteUrl();
  if (!baseUrl) throw new Error("InsForge base URL not configured");
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessToken}`,
  };
  const anonKey = getInsforgeAnonKey();
  if (anonKey) headers.apikey = anonKey;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CLOUD_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/functions/${CLOUD_SLUG}`, {
      method,
      headers,
      cache: "no-store",
      signal: controller.signal,
      ...(body == null ? {} : { body: JSON.stringify(body) }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(payload?.error || `Request failed with HTTP ${response.status}`);
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

export function getAccountSkillInventories(accessToken: string) {
  return fetchCloudSkillsJson({ accessToken });
}

export function publishSkillInventory({
  accessToken,
  deviceId,
  skills,
}: {
  accessToken: string;
  deviceId: string;
  skills: AnyRecord[];
}) {
  return fetchCloudSkillsJson({
    accessToken,
    method: "POST",
    body: {
      device_id: deviceId,
      skills: buildSkillInventoryMetadata(skills),
    },
  });
}
