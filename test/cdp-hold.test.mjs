// Regression test for 2026-10-15: `browse-cdp Emulation.setCPUThrottlingRate
// '{"rate": 4}'` printed {} and exited 0, yet the next command ran at full
// speed (a busy loop took 21 ms before and 22 ms after). Chrome clears CPU
// throttling and network emulation when the CDP session that set them detaches,
// and browse-cdp detached as it exited. The CDP call itself succeeds, so only a
// timing ratio sees the failure.
//
// Needs a real browser: launches its own headless Chrome for Testing (or
// CHROME_PATH) with a temp profile and a temp HOME, so the shared browser and
// the real lease directory are never touched. Skips, with the reason printed,
// when no such browser is installed.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../bin/", import.meta.url));

// Same lookup as browse-start: CHROME_PATH, else the newest Chrome for Testing.
function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const root = join(process.env.BROWSE_CHROME_HOME || join(homedir(), ".browse-tool", "chrome"), "chrome");
  let versions = [];
  try { versions = readdirSync(root).sort().reverse(); } catch {}
  for (const v of versions) {
    for (const arch of ["chrome-mac-arm64", "chrome-mac-x64"]) {
      const p = join(root, v, arch, "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing");
      if (existsSync(p)) return p;
    }
  }
  return null;
}

const CHROME = findChrome();
const SKIP = CHROME ? false : "no Chrome for Testing under ~/.browse-tool/chrome and no CHROME_PATH";

// Median of three timed runs of a busy loop, in ms. The sink write keeps V8
// from discarding the loop.
const LOOP =
  "const t = []; for (let r = 0; r < 3; r++) { const s = performance.now(); let x = 0; " +
  "for (let i = 0; i < 5e7; i++) x += i % 7; globalThis.__sink = x; t.push(performance.now() - s); } " +
  "return t.sort((a, b) => a - b)[1]";

let chrome, profile, home, env, server, origin;

/** Run a command to completion: stdin closed, bounded, output captured. */
function run(cmd, args, { timeout = 60000, envOverride = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: { ...env, ...envOverride }, stdio: ["ignore", "pipe", "pipe"], timeout });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code, signal) => resolve({ code, signal, stdout: stdout.trim(), stderr: stderr.trim() }));
  });
}
const bin = (name, ...args) => run(join(BIN, name), args);

/** browse-eval's loop timing, failing with the raw output when it is not a number. */
function ms(result, label) {
  assert.equal(result.code, 0, `${label} exited ${result.code}: ${result.stderr}`);
  assert.match(result.stdout, /^\d+(\.\d+)?$/, `${label} should print the loop time, got: ${result.stdout}`);
  return Number(result.stdout);
}

before(async () => {
  if (SKIP) return;
  profile = mkdtempSync(join(tmpdir(), "browse-cdp-hold-profile-"));
  home = mkdtempSync(join(tmpdir(), "browse-cdp-hold-home-"));
  chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "about:blank"], { stdio: "ignore" });
  // Port 0 lets Chrome pick a free port; it writes the choice to DevToolsActivePort.
  const portFile = join(profile, "DevToolsActivePort");
  for (let i = 0; i < 100 && !existsSync(portFile); i++) await new Promise((r) => setTimeout(r, 100));
  const port = readFileSync(portFile, "utf8").split("\n")[0];
  // No harness id, as from a plain shell: sessionId() then falls back to the
  // parent pid, the case where a held command could land in a different tab.
  env = { ...process.env, HOME: home, BROWSE_PORT: port };
  for (const k of ["BROWSE_SESSION", "CLAUDE_CODE_SESSION_ID", "CODEX_COMPANION_SESSION_ID", "CODEX_THREAD_ID",
    "BROWSE_SHARED_TAB", "BROWSE_INCOGNITO"]) delete env[k];
  server = createServer((req, res) => { res.setHeader("content-type", "text/html"); res.end("<p>ok</p>"); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${server.address().port}`;
  const nav = await bin("browse-nav", `${origin}/`);
  assert.equal(nav.code, 0, nav.stderr);
});

after(async () => {
  if (SKIP) return;
  chrome?.kill();
  server?.close();
  await new Promise((r) => setTimeout(r, 300));
  for (const dir of [profile, home]) if (dir) rmSync(dir, { recursive: true, force: true });
});

test("a held CPU throttle slows the wrapped command, then ends with it", { skip: SKIP, timeout: 90000 }, async (t) => {
  const base = ms(await bin("browse-eval", LOOP), "baseline browse-eval");
  const held = ms(
    await bin("browse-cdp", "Emulation.setCPUThrottlingRate", '{"rate": 4}', "--", join(BIN, "browse-eval"), LOOP),
    "browse-eval held under browse-cdp",
  );
  const afterwards = ms(await bin("browse-eval", LOOP), "browse-eval after the hold");
  const ratio = held / base;
  t.diagnostic(`busy loop: ${base.toFixed(1)} ms bare, ${held.toFixed(1)} ms held (${ratio.toFixed(2)}x), ${afterwards.toFixed(1)} ms after`);
  // Measured 4.05x at rate 4; 2 leaves room for a busy machine.
  assert.ok(ratio >= 2, `rate 4 should slow the loop at least 2x: ${base.toFixed(1)} -> ${held.toFixed(1)} ms (${ratio.toFixed(2)}x)`);
  // The other direction: the throttle must not outlive the command that held it.
  assert.ok(afterwards / base < 1.5, `throttle leaked past the hold: ${base.toFixed(1)} -> ${afterwards.toFixed(1)} ms`);
});

test("--port reaches the wrapped command", { skip: SKIP, timeout: 90000 }, async () => {
  // BROWSE_PORT names a port nothing listens on, so a child that lost --port
  // fails to connect instead of reaching some other browser, such as the shared one.
  const base = ms(await bin("browse-eval", LOOP), "baseline browse-eval");
  const held = ms(
    await run(join(BIN, "browse-cdp"), ["--port", env.BROWSE_PORT, "Emulation.setCPUThrottlingRate", '{"rate": 4}',
      "--", join(BIN, "browse-eval"), LOOP], { envOverride: { BROWSE_PORT: "1" } }),
    "browse-eval held under browse-cdp --port",
  );
  assert.ok(held / base >= 2, `rate 4 via --port should slow the loop at least 2x: ${base.toFixed(1)} -> ${held.toFixed(1)} ms`);
});

test("a held network emulation applies to the wrapped command", { skip: SKIP, timeout: 60000 }, async () => {
  const fetchCode = `try { const r = await fetch('${origin}/x?' + Math.random()); return 'status ' + r.status } catch (e) { return 'failed' }`;
  const offline = '{"offline": true, "latency": 0, "downloadThroughput": -1, "uploadThroughput": -1}';
  const held = await bin("browse-cdp", "Network.emulateNetworkConditions", offline, "--", join(BIN, "browse-eval"), fetchCode);
  assert.equal(held.code, 0, held.stderr);
  assert.equal(held.stdout, "failed", "the wrapped fetch should run offline");
  const afterwards = await bin("browse-eval", fetchCode);
  assert.equal(afterwards.stdout, "status 200", "the network emulation must end with the hold");
});

test("bare session-scoped overrides are refused, not silently dropped", { skip: SKIP, timeout: 60000 }, async () => {
  for (const [method, params] of [
    ["Emulation.setCPUThrottlingRate", '{"rate": 4}'],
    ["Network.emulateNetworkConditions", '{"offline": true, "latency": 0, "downloadThroughput": -1, "uploadThroughput": -1}'],
  ]) {
    const bare = await bin("browse-cdp", method, params);
    assert.notEqual(bare.code, 0, `${method} without a command to hold for should fail, got stdout: ${bare.stdout}`);
    assert.match(bare.stderr, / -- /, `${method}'s refusal should show the held form`);
  }
});

test("held mode passes the wrapped command's exit code through", { skip: SKIP, timeout: 60000 }, async () => {
  const failing = await bin("browse-cdp", "Emulation.setCPUThrottlingRate", '{"rate": 2}', "--", join(BIN, "browse-eval"), "throw new Error('boom')");
  assert.equal(failing.code, 1, failing.stderr);
  assert.equal(failing.stdout, "", "held mode keeps stdout for the wrapped command");
});
