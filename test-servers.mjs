// MCP protocol smoke test
import { spawn } from "child_process";

const TSC = "C:\\Users\\夏云飞\\AppData\\Local\\hermes\\node\\tsx";

const servers = [
  { name: "mcp-filesystem", cmd: process.execPath, args: ["--import", "tsx", "C:/Users/夏云飞/mcp-hub/servers/filesystem/src/index.ts"] },
  { name: "mcp-database",  cmd: process.execPath, args: ["--import", "tsx", "C:/Users/夏云飞/mcp-hub/servers/database/src/index.ts"] },
  { name: "mcp-gateway",   cmd: process.execPath, args: ["--import", "tsx", "C:/Users/夏云飞/mcp-hub/servers/gateway/src/index.ts"] },
];

async function testServer(name, cmd, args) {
  return new Promise((resolveTest) => {
    const child = spawn(cmd, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, NODE_PATH: process.env.NODE_PATH || "" },
    });

    let output = "";
    let errOutput = "";
    let resolved = false;

    const finish = (ok, detail) => {
      if (resolved) return;
      resolved = true;
      child.kill();
      resolveTest({ name, ok, detail });
    };

    child.stdout.on("data", (data) => {
      output += data.toString();
      try {
        const lines = output.split("\n").filter(Boolean);
        for (const line of lines) {
          const msg = JSON.parse(line);
          if (msg.result && msg.id === 1) {
            finish(true, `${msg.result.serverInfo?.name} v${msg.result.serverInfo?.version} — tools:${msg.result.capabilities?.tools ? "OK" : "NO"} resources:${msg.result.capabilities?.resources ? "OK" : "NO"}`);
          } else if (msg.error) {
            finish(false, `JSON-RPC error: ${JSON.stringify(msg.error)}`);
          }
        }
      } catch {}
    });

    child.stderr.on("data", (d) => { errOutput += d.toString(); });
    child.on("error", (err) => finish(false, `Spawn: ${err.message}`));

    child.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    }) + "\n");

    setTimeout(() => {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    }, 300);

    setTimeout(() => finish(false, `Timeout. stderr: ${errOutput.slice(0, 300)}`), 10000);
  });
}

console.log("MCP Hub Smoke Test\n");

for (const s of servers) {
  const r = await testServer(s.name, s.cmd, s.args);
  console.log(`[${r.ok ? "PASS" : "FAIL"}] ${r.name}`);
  console.log(`      ${r.detail}\n`);
}
console.log("Done.");
