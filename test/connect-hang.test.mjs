// Regression test for the 2026-09-23 hang: every browse-* command parked forever
// inside puppeteer.connect() when Chrome reported a `page` target that no tab
// ever auto-attached (the "Separate Browsing?" sign-in bubble).
//
// A fake CDP browser reproduces it on purpose: it announces page targets and
// never attaches any of them. Run: node --test test/
//
// `ws` comes in through puppeteer-core; it is not a direct dependency.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";

const BIN = fileURLToPath(new URL("../bin/", import.meta.url));

/** A browser endpoint that answers every command and attaches to nothing. */
async function fakeBrowser(targets) {
  const http = createServer((req, res) => {
    const { port } = http.address();
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      Browser: "Fake/1.0",
      webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/fake`,
    }));
  });
  const wss = new WebSocketServer({ server: http });
  wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
      const { id, method } = JSON.parse(raw);
      const infos = targets.map((t) => ({
        attached: false,
        canAccessOpener: false,
        browserContextId: "CTX",
        title: "",
        ...t,
      }));
      let result = {};
      if (method === "Browser.getVersion") {
        result = { protocolVersion: "1.3", product: "Chrome/152.0", revision: "", userAgent: "Fake", jsVersion: "" };
      }
      if (method === "Target.getBrowserContexts") result = { browserContextIds: [] };
      if (method === "Target.getTargets") result = { targetInfos: infos };
      // Acknowledge a new tab that never appears, so tab lookup waits forever.
      if (method === "Target.createTarget") result = { targetId: "NEVERAPPEARS0000" };
      if (method === "Target.setDiscoverTargets") {
        for (const targetInfo of infos) {
          ws.send(JSON.stringify({ method: "Target.targetCreated", params: { targetInfo } }));
        }
      }
      ws.send(JSON.stringify({ id, result }));
    });
  });
  await new Promise((r) => http.listen(0, "127.0.0.1", r));
  return { port: http.address().port, close: () => { wss.close(); http.close(); } };
}

function run(bin, args, port, env = {}, killAfterMs = 15000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN + bin, ...args], {
      env: { ...process.env, BROWSE_PORT: String(port), BROWSE_SESSION: "connect-hang-test", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    // Outer bound so a regression reports as a failure, not a stuck suite.
    const kill = setTimeout(() => child.kill("SIGKILL"), killAfterMs);
    child.on("exit", (code, signal) => {
      clearTimeout(kill);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

test("a tabless sign-in bubble no longer blocks connect", async () => {
  const b = await fakeBrowser([
    { targetId: "BUBBLE00000000", type: "page", url: "chrome://signin-dice-web-intercept.top-chrome/" },
  ]);
  try {
    const r = await run("browse-tabs", [], b.port, { BROWSE_TIMEOUT: "5" });
    assert.equal(r.signal, null, `killed by the outer bound: ${r.stderr}`);
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /signin-dice/, "browser UI must not be listed as a tab");
  } finally {
    b.close();
  }
});

test("an unattachable page fails loudly with a diagnosis instead of hanging", async () => {
  const b = await fakeBrowser([
    { targetId: "STUCKPAGE0000000", type: "page", url: "https://example.com/never-attaches" },
  ]);
  try {
    const started = Date.now();
    const r = await run("browse-eval", ["return 1"], b.port, { BROWSE_TIMEOUT: "2" });
    assert.equal(r.signal, null, "watchdog never fired; the outer bound killed it");
    assert.equal(r.code, 124);
    assert.match(r.stderr, /timed out after 2s during connect/);
    assert.match(r.stderr, /STUCKPAG.*never-attaches/);
    assert.ok(Date.now() - started < 10000);
  } finally {
    b.close();
  }
});

test("BROWSE_TIMEOUT rejects a value that is not seconds", async () => {
  const b = await fakeBrowser([]);
  try {
    const r = await run("browse-tabs", [], b.port, { BROWSE_TIMEOUT: "soon" });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /BROWSE_TIMEOUT must be a number/);
  } finally {
    b.close();
  }
});

test("a command that opts out of timing still times its tab lookup", async () => {
  const b = await fakeBrowser([]);
  try {
    const r = await run("browse-pick", [], b.port, { BROWSE_TIMEOUT: "2" });
    assert.equal(r.signal, null, "tab lookup was untimed; the outer bound killed it");
    assert.equal(r.code, 124);
    assert.match(r.stderr, /during tab lookup/);
  } finally {
    b.close();
    rmSync(join(homedir(), ".browse-tool", "leases", "connect-hang-test.json"), { force: true });
  }
});
