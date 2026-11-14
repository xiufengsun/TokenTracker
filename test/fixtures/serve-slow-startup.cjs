// Block maintenance until the parent has exercised the real HTTP listener.
const init = require("../../src/commands/init");
const sync = require("../../src/commands/sync");
const pricing = require("../../src/lib/pricing");
const telemetry = require("../../src/lib/telemetry");
const star = require("../../src/lib/star-cta");
pricing.ensurePricingLoaded = async () => {};
telemetry.maybeSendHeartbeat = async () => {};
star.maybeShowStarCta = async () => { process.send({ phase: "complete" }); };
init.installLocalTrackerApp = async () => {
  process.send({ phase: "install" });
  await new Promise((resolve) => process.once("message", resolve));
};
init.repairRuntimeIntegrations = async () => {
  process.send({ phase: "repair" });
  return { warnings: [] };
};
init.cmdInit = async () => { process.send({ phase: "init" }); };
sync.cmdSync = async () => { process.send({ phase: "sync" }); };
require("../../src/commands/serve").cmdServe(["--port", process.argv[2], "--no-open"])
  .catch((error) => { console.error(error); process.exit(1); });
