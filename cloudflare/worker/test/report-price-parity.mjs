// Read the two authorized, archived production edge bundles and one local rehearsal database.
// Extract only the pre-existing pricing functions from those files and return aggregate totals.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {deployedCalculator} from "./report-deployed-calculator.mjs";
import { build } from "esbuild";
const [archive, snapshot]=process.argv.slice(2);
const db=new DatabaseSync(snapshot,{readOnly:true});
const module=(await build({stdin:{contents:
  'export {computeRowCost} from "./src/report-pricing";export {publicRowCost} from "./src/report-public-pricing"',
  resolveDir:import.meta.dirname+"/.."},bundle:true,write:false,target:"node24",platform:"node",format:"esm"})).outputFiles[0];
const {computeRowCost,publicRowCost}=await import("data:text/javascript;base64,"+Buffer.from(module.contents).toString("base64"));
const getPricing=name=>deployedCalculator(archive,name).calculate;
const oldPublic=getPricing("leaderboard-refresh"),oldProfile=getPricing("leaderboard-profile"),oldAccount=getPricing("account-daily");
const sql=`SELECT source,model,pricing_tier,sum(input_tokens) AS input_tokens,sum(output_tokens) AS output_tokens,
 sum(cached_input_tokens) AS cached_input_tokens,sum(cache_creation_input_tokens) AS cache_creation_input_tokens,
 sum(reasoning_output_tokens) AS reasoning_output_tokens FROM tokentracker_leaderboard_rollup_daily_v2 GROUP BY source,model,pricing_tier`;
let dimensions=0, differingContexts=0,publicUsd=0,privateUsd=0;
for(const row of db.prepare(sql).iterate()) {
 const pub=publicRowCost(row),priv=computeRowCost(row);
 for(const [target,baseline] of [[pub,oldPublic(row)],[pub,oldProfile(row)],[priv,oldAccount(row)]]) {
    assert.ok(Math.abs(target-baseline)<=Math.max(Math.abs(baseline)*1e-12,1e-9),"Deployed pricing mismatch");
 }
 dimensions++;publicUsd+=pub;privateUsd+=priv;if(Math.abs(pub-priv)>1e-9)differingContexts++;
}
assert.ok(dimensions);
console.log(JSON.stringify({dimensions,differingContexts,publicUsd,privateUsd,allThreeDeployedFunctionsMatched:true,
 basis:"all source daily rollup dimensions without leaderboard exclusions or row rounding"}));
db.close();
