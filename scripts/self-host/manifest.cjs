const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname,"../..");
const read = name => fs.readFileSync(path.join(root,name),"utf8");
function functionSql(source,name) {
  const matchName = source.match(new RegExp(`CREATE(?: OR REPLACE)? FUNCTION public\\.${name}\\(`));
  const start = matchName?.index ?? -1;
  if (start < 0) throw Error(`Missing reviewed function ${name}`);
  const match = source.slice(start).match(/AS (\$\w*\$)/);
  if (!match) throw Error(`Missing function delimiter ${name}`);
  const body = source.indexOf(match[1],start)+match[1].length;
  const end = source.indexOf(match[1]+";",body);
  if (end < 0) throw Error(`Missing function end ${name}`);
  return source.slice(start,end+match[1].length+1).replace(/^CREATE FUNCTION/,"CREATE OR REPLACE FUNCTION");
}
const privateFunctions = [
  "tokentracker-device-flow-authorize","tokentracker-device-flow-grant","tokentracker-device-flow-poll",
  "tokentracker-device-token-issue","tokentracker-device-rename","tokentracker-ingest",
  "tokentracker-account-summary","tokentracker-account-daily","tokentracker-account-hourly",
  "tokentracker-account-monthly","tokentracker-account-heatmap","tokentracker-account-model-breakdown",
  "tokentracker-account-devices","tokentracker-billing",
];
function steps() {
  const sessions=read("migrations/20260817120000_account-session-states.sql");
  const concurrent=read("migrations/20260719152022_harden-backend-concurrency.sql");
  return [
    {id:"01-private-baseline",sql:read("scripts/self-host/baseline.sql")},
    {id:"02-account-sessions",sql:sessions.slice(0,sessions.indexOf("-- Leaderboard: account-level sources")) + `
CREATE TRIGGER self_host_sessions_insert_cache AFTER INSERT ON public.tokentracker_account_session_states
  REFERENCING NEW TABLE AS changed_new FOR EACH STATEMENT EXECUTE FUNCTION public.self_host_invalidate_usage_cache();
CREATE TRIGGER self_host_sessions_update_cache AFTER UPDATE ON public.tokentracker_account_session_states
  REFERENCING OLD TABLE AS changed_old NEW TABLE AS changed_new FOR EACH STATEMENT EXECUTE FUNCTION public.self_host_invalidate_usage_cache();
CREATE TRIGGER self_host_sessions_delete_cache AFTER DELETE ON public.tokentracker_account_session_states
  REFERENCING OLD TABLE AS changed_old FOR EACH STATEMENT EXECUTE FUNCTION public.self_host_invalidate_usage_cache();` },
    {id:"03-device-identity",sql:functionSql(concurrent,"refresh_tokentracker_device_identity")},
    {id:"04-private-aggregation",sql:[
      read("scripts/self-host/aggregation.sql"),
      functionSql(read("migrations/20260904090000_promote-single-scan-account-usage.sql"),"account_usage_grouped_v2"),
      functionSql(concurrent,"account_usage_grouped_cached"),
      read("migrations/20260918041500_fold-account-summary-and-heatmap-aggregation.sql"),
      read("migrations/20260918043000_fold-account-model-breakdown-aggregation.sql"),
      read("migrations/20260918050000_fold-account-daily-aggregation.sql"),
      read("migrations/20261002090000_compact-account-model-wire.sql"),
      read("migrations/20261003093000_compact-account-summary-model-wire.sql"),
      read("scripts/self-host/private-rpc-access.sql"),
    ].join("\n\n")},
    ...["20261003120000_cloud-subscriptions.sql","20261004120000_cloud-machine-access.sql",
      "20261007120000_cloud-waffo.sql","20261007130000_cloud-waffo-retry.sql","20261007140000_cloud-waffo-attempts.sql",
      "20261007150000_cloud-waffo-authorizations.sql","20261007160000_cloud-waffo-sandbox-periods.sql"]
      .map(name=>({id:name.slice(0,-4),sql:read("migrations/"+name)})),
    {id:"10-self-hosted-policy",sql:read("migrations/20261008120000_self-hosted-access.sql")},
    {id:"11-token-environment-validation",sql:read("migrations/20261008120001_validate-cloud-token-environment.sql")},
    {id:"12-pro-gifts",sql:read("migrations/20261009120000_cloud-gifts.sql")},
  ];
}
module.exports={root,read,functionSql,privateFunctions,steps};
