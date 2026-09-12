const { spawn } = require("node:child_process");

// A fixed Security.framework operation. Credential payloads travel over stdin,
// never argv, shell text, temporary scripts, or diagnostic output. Background
// reads explicitly prohibit authentication UI.
async function keychainOperation({ service, account, action = "read", value, interactive = false }) {
  if (!/^Claude Code-credentials(?:-[a-f0-9]{8})?$/.test(service) || !/^[a-zA-Z0-9._-]+$/.test(account)
    || !["read", "write", "delete"].includes(action)) throw new Error("Invalid credential operation");
  const payload = JSON.stringify({ service, account, action, value, interactive });
  const script = `ObjC.import('Foundation'); ObjC.import('Security');
function run() {
  const p = ${payload}; const c = ObjC.castRefToObject;
  $.SecKeychainSetUserInteractionAllowed(p.interactive);
  const q = $.NSMutableDictionary.alloc.init;
  q.setObjectForKey(c($.kSecClassGenericPassword), c($.kSecClass));
  q.setObjectForKey($(p.service), c($.kSecAttrService));
  q.setObjectForKey($(p.account), c($.kSecAttrAccount));
  let code;
  if (p.action === 'read') {
    q.setObjectForKey($(true), c($.kSecReturnData));
    q.setObjectForKey(c($.kSecMatchLimitOne), c($.kSecMatchLimit));
    const result = Ref(); code = $.SecItemCopyMatching(q, result);
    if (code === 0) return JSON.stringify({found:true,value:ObjC.unwrap($.NSString.alloc.initWithDataEncoding(c(result[0]), $.NSUTF8StringEncoding))});
  } else if (p.action === 'delete') { code = $.SecItemDelete(q); }
  else {
    const data = $(p.value).dataUsingEncoding($.NSUTF8StringEncoding);
    const attrs = $.NSMutableDictionary.alloc.init; attrs.setObjectForKey(data, c($.kSecValueData));
    code = $.SecItemUpdate(q, attrs);
    if (code === -25300) { q.setObjectForKey(data, c($.kSecValueData)); code = $.SecItemAdd(q, null); }
  }
  return JSON.stringify({found:code === 0,code:code});
}`;
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/osascript", ["-l", "JavaScript"], { stdio: ["pipe", "pipe", "pipe"], shell: false });
    let output = "";
    const timeout = setTimeout(() => { child.kill("SIGTERM"); }, interactive ? 60000 : 5000);
    child.stdout.on("data", (chunk) => { output += chunk; if (output.length > 128 * 1024) child.kill("SIGTERM"); });
    child.stderr.resume();
    child.stdin.on("error", () => {});
    child.once("error", () => { clearTimeout(timeout); reject(new Error("Credential storage unavailable")); });
    child.once("close", (code) => {
      clearTimeout(timeout);
      try {
        if (code !== 0) throw new Error();
        const result = JSON.parse(output);
        if (!result.found && result.code !== -25300) throw new Error();
        resolve(result);
      } catch { reject(new Error("Credential storage requires access")); }
    });
    child.stdin.end(script);
  });
}
module.exports = { keychainOperation };
