type BadgeClient = {
  database: {
    rpc: (name: string, params: Record<string, unknown>) => PromiseLike<{ data?: unknown; error?: unknown }>;
  };
};

export async function readProBadges(client: BadgeClient, userIds: string[]): Promise<Record<string, boolean>> {
  const ids = [...new Set(userIds)].filter(Boolean);
  if (!ids.length) return {};
  try {
    // Public leaderboard endpoints always read live membership. Request
    // parameters and caller tokens cannot select the sandbox ledger.
    const { data, error } = await client.database.rpc("cloud_pro_badges", { p_user_ids: ids });
    if (error || !data || typeof data !== "object" || Array.isArray(data)) return {};
    return Object.fromEntries(ids.map(id => [id, (data as Record<string, unknown>)[id] === true]));
  } catch {
    // An older backend or a billing outage must not hide the free leaderboard.
    return {};
  }
}
