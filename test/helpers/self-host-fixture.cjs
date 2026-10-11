const fs=require("node:fs/promises");
const path=require("node:path");
const os=require("node:os");
const http=require("node:http");
const Module=require("node:module");
const {randomUUID,createHmac}=require("node:crypto");
const {build}=require("esbuild");
const {PGlite}=require("@electric-sql/pglite");
const {install}=require("../../scripts/self-host/install.cjs");
const {buildFunctions}=require("../../scripts/self-host/build-functions.cjs");
const {privateFunctions}=require("../../scripts/self-host/manifest.cjs");
const root=path.resolve(__dirname,"../..");
const identifier=value=>{if(!/^[a-z_][a-z0-9_]*$/i.test(value.trim()))throw Error("Unsupported SQL identifier");return '"'+value.trim()+'"';};
async function platform() {
  const db=new PGlite();
  await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE project_admin BYPASSRLS;
    CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    GRANT USAGE ON SCHEMA auth TO project_admin;
    GRANT SELECT(id) ON auth.users TO project_admin;`);
  return db;
}
async function fixture() {
  const db=await platform();await install(db);await install(db);
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),"tokentracker-self-host-"));
  const manifest=await buildFunctions(directory);
  const sdk=path.join(path.dirname(require.resolve("@insforge/sdk",{paths:[path.join(root,"dashboard")]})),"index.mjs");
  const handlers={};
  for(const slug of privateFunctions) {
    const filename=path.join(directory,slug+".js");
    const output=await build({entryPoints:[filename],bundle:true,write:false,format:"cjs",platform:"node",target:"node20",logLevel:"silent",
      alias:{"npm:@insforge/sdk":sdk,"npm:@insforge/sdk@1.4.5":sdk,
        "npm:@waffo/pancake-ts@0.25.0":require.resolve("@waffo/pancake-ts"),"npm:alipay-sdk@4.14.0":require.resolve("alipay-sdk")},
      plugins:[{name:"locked-self-host-fixture-imports",setup(builder){
        builder.onResolve({filter:/^npm:/},args=>{
          const match=args.path.match(/^npm:((?:@[^/]+\/)?[^@/]+)@([^/]+)(\/.*)?$/);
          if(!match)throw Error("Unpinned self-host fixture dependency: "+args.path);
          if(match[1]==="@insforge/sdk")return {path:sdk};
          return {path:require.resolve(match[1]+(match[3]||""),{paths:[path.join(root,"node_modules/urllib"),root]})};
        });
      }}]});
    const compiled=new Module(filename,module);compiled.filename=filename;compiled.paths=Module._nodeModulePaths(path.dirname(filename));
    compiled._compile(output.outputFiles[0].text,filename);handlers[slug]=compiled.exports.default||compiled.exports;
  }
  const originalFetch=globalThis.fetch;const previousDeno=globalThis.Deno;
  const secret="isolated-self-host-fixture-"+randomUUID();let base;
  const token=(sub,role="authenticated",exp=Math.floor(Date.now()/1000)+3600)=>{
    const header=Buffer.from(JSON.stringify({alg:"HS256"})).toString("base64url");
    const body=Buffer.from(JSON.stringify({sub,role,exp})).toString("base64url");
    return `${header}.${body}.${createHmac("sha256",secret).update(`${header}.${body}`).digest("base64url")}`;
  };
  const env={INSFORGE_SERVICE_ROLE_KEY:token(randomUUID(),"project_admin"),ANON_KEY:token(randomUUID(),"anon"),
    JWT_SECRET:secret,TOKENTRACKER_BILLING_ENVIRONMENT:"live",TOKENTRACKER_DASHBOARD_URL:"https://private.example.test"};
  const serverCredential=env.INSFORGE_SERVICE_ROLE_KEY;
  const server=http.createServer(async(req,res)=>{
    const send=(status,value)=>{res.writeHead(status,{"Content-Type":"application/json"});res.end(JSON.stringify(value));};
    let raw="";for await(const chunk of req)raw+=chunk;
    const url=new URL(req.url,base);
    try {
      if(url.pathname.startsWith("/functions/")) {
        const handler=handlers[url.pathname.split("/").pop()];
        if(!handler){send(404,{error:"Function not installed"});return;}
        const result=await handler(new Request(url,{method:req.method,headers:req.headers,...(raw?{body:raw}:{})}));
        res.writeHead(result.status,Object.fromEntries(result.headers));res.end(await result.text());return;
      }
      if(req.headers.authorization!=="Bearer "+serverCredential){send(403,{message:"server role required"});return;}
      await db.transaction(async tx=>{
        await tx.exec("SET LOCAL ROLE project_admin");
        if(url.pathname.startsWith("/api/database/rpc/")) {
          const args=JSON.parse(raw||"{}");const names=Object.keys(args);
          const values=names.map(name=>args[name]&&typeof args[name]==="object"&&!Array.isArray(args[name])?JSON.stringify(args[name]):args[name]);
          const result=await tx.query(`SELECT ${identifier(url.pathname.split("/").pop())}(${names.map((name,index)=>identifier(name)+" => $"+(index+1)).join(",")}) AS r`,values);
          send(200,result.rows[0].r);return;
        }
        const table=identifier(url.pathname.split("/").pop());const args=[];const filters=[];
        for(const [key,value]of url.searchParams) {
          if(["select","order","limit","offset","columns"].includes(key))continue;
          const column=identifier(key);
          if(value==="is.null")filters.push(column+" IS NULL");
          else if(value==="not.is.null")filters.push(column+" IS NOT NULL");
          else if(value.startsWith("in.(")){args.push(value.slice(4,-1).split(","));filters.push(column+"::text=ANY($"+args.length+"::text[])");}
          else {const at=value.indexOf(".");const op={eq:"=",neq:"<>",gte:">=",gt:">",lte:"<=",lt:"<"}[value.slice(0,at)];if(!op)throw Error("Unsupported SQL filter "+key);args.push(value.slice(at+1));filters.push(column+op+"$"+args.length);}
        }
        const where=filters.length?" WHERE "+filters.join(" AND "):"";
        const selection=url.searchParams.get("select")||"*";const selected=selection==="*"?"*":selection.split(",").map(identifier).join(",");
        let result;
        if(req.method==="POST") {
          const rows=JSON.parse(raw);if(!Array.isArray(rows))throw Error("Expected SDK array insert");
          const names=Object.keys(rows[0]);const values=rows.flatMap(row=>names.map(name=>row[name]));
          result=await tx.query(`INSERT INTO ${table} (${names.map(identifier).join(",")}) VALUES ${rows.map((_,row)=>"("+names.map((_,column)=>"$"+(row*names.length+column+1)).join(",")+")").join(",")} RETURNING *`,values);
        } else if(req.method==="PATCH") {
          const values=JSON.parse(raw);const names=Object.keys(values);const initial=args.length;args.push(...names.map(name=>values[name]));
          result=await tx.query(`UPDATE ${table} SET ${names.map((name,index)=>identifier(name)+"=$"+(initial+index+1)).join(",")}${where} RETURNING ${selected}`,args);
        } else {
          let sql=`SELECT ${selected} FROM ${table}${where}`;
          if(url.searchParams.has("order"))sql+=" ORDER BY "+url.searchParams.get("order").split(",").map(part=>{const [name,direction]=part.split(".");return identifier(name)+(direction==="desc"?" DESC":" ASC");}).join(",");
          sql+=" LIMIT "+Math.min(100,Number(url.searchParams.get("limit"))||100)+" OFFSET "+(Number(url.searchParams.get("offset"))||0);
          result=await tx.query(sql,args);
        }
        if(req.headers.accept?.includes("vnd.pgrst.object")) {
          if(result.rows.length!==1){send(406,{code:"PGRST116",message:"No single object",details:"The result contains "+result.rows.length+" rows"});return;}
          send(200,result.rows[0]);
        } else send(200,result.rows);
      });
    } catch(error){if(process.env.TOKENTRACKER_SELF_HOST_FIXTURE_DEBUG)console.error(error.message);send(500,{code:error.code||"SELF_HOST_SQL",message:error.message});}
  });
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));base="http://127.0.0.1:"+server.address().port;env.INSFORGE_BASE_URL=base;
  globalThis.Deno={env:{get:key=>env[key]}};
  globalThis.fetch=async(input,init)=>{const url=new URL(typeof input==="string"?input:input.url||input.href);if(url.origin!==base)throw Error("Self-host fixture attempted another backend");return originalFetch(input,init);};
  return {db,env,manifest,base,token,
    user:async()=>{const id=randomUUID();await db.query("INSERT INTO auth.users VALUES($1)",[id]);return id;},
    request:async(slug,value,owner)=>{const response=await originalFetch(base+"/functions/"+slug,{method:value===undefined?"GET":"POST",
      headers:{...(owner?{Authorization:"Bearer "+(/^[0-9a-f-]{36}$/i.test(owner)?token(owner):owner)}:{}),"Content-Type":"application/json"},
      ...(value===undefined?{}:{body:JSON.stringify(value)})});return {response,data:await response.json()};},
    close:async()=>{globalThis.fetch=originalFetch;if(previousDeno===undefined)delete globalThis.Deno;else globalThis.Deno=previousDeno;
      await new Promise(resolve=>server.close(resolve));await db.close();await fs.rm(directory,{recursive:true,force:true});},
  };
}
module.exports={platform,fixture};
