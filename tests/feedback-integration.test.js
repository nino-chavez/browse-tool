import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, symlink, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { FeedbackRepository } from "../lib/feedback-repository.js";

const root = await mkdtemp(join(tmpdir(), "feedback-integration-"));
const bin = (name) => fileURLToPath(new URL(`../bin/${name}`, import.meta.url));
const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6V9kAAAAASUVORK5CYII=";
const annotation = { kind: "page", comment: "Synthetic test comment", context: { url: "https://example.com/", title: "Test page", viewport: { width: 1, height: 1, devicePixelRatio: 1 }, scroll: { x: 0, y: 0 } }, target: {} };
const run = (name, args, input = Buffer.alloc(0)) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [bin(name), ...args], { stdio: ["pipe", "pipe", "pipe"], timeout: 10000 });
  const stdout = [], stderr = [];
  child.stdout.on("data", (part) => stdout.push(part)); child.stderr.on("data", (part) => stderr.push(part));
  child.on("error", reject); child.on("close", (code) => resolve({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString() }));
  child.stdin.end(input);
});
const frame = (request) => { const body = Buffer.from(JSON.stringify(request)); const head = Buffer.alloc(4); head.writeUInt32LE(body.length); return Buffer.concat([head, body]); };
const native = async (request) => {
  const response = await run("feedback-native", ["--root", root, "chrome-extension://test/"], frame(request));
  assert.equal(response.code, 0, response.stderr);
  assert.equal(response.stdout.readUInt32LE(), response.stdout.length - 4);
  return JSON.parse(response.stdout.subarray(4).toString());
};

test("native helper, CLI, and real MCP SDK client share the same saved batch", { timeout: 20000 }, async () => {
  const created = await native({ action: "create", title: "Integration test" }); assert.equal(created.ok, true);
  const batchId = created.result.batchId;
  const saved = await native({ action: "save", batchId, annotation, screenshot: png }); assert.equal(saved.ok, true);
  const annotationId = saved.result.id;
  const cli = await run("browse-feedback", ["read", "--root", root, "--batch", batchId]);
  assert.equal(cli.code, 0, cli.stderr); assert.equal(JSON.parse(cli.stdout).annotations[0].comment, annotation.comment);
  const transport = new StdioClientTransport({ command: process.execPath, args: [bin("feedback-mcp"), "--root", root], stderr: "pipe" });
  const client = new Client({ name: "annotation-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ["list_feedback", "read_feedback", "read_feedback_screenshot", "set_feedback_status"]);
    const listed = await client.callTool({ name: "list_feedback", arguments: {} });
    assert.equal(JSON.parse(listed.content[0].text).batches[0].batchId, batchId);
    const read = await client.callTool({ name: "read_feedback", arguments: { batchId } });
    assert.equal(JSON.parse(read.content[0].text).annotations[0].id, annotationId);
    const image = await client.callTool({ name: "read_feedback_screenshot", arguments: { batchId, annotationId } });
    assert.equal(image.content[0].type, "image"); assert.equal(image.content[0].data, png.split(",")[1]);
    const updated = await client.callTool({ name: "set_feedback_status", arguments: { batchId, annotationId, status: "resolved" } });
    assert.equal(updated.isError, undefined);
    const reread = await native({ action: "get", batchId }); assert.equal(reread.result.annotations[0].status, "resolved");
    const reopened = await run("browse-feedback", ["status", "--root", root, "--batch", batchId, "--id", annotationId, "--status", "open"]);
    assert.equal(reopened.code, 0, reopened.stderr);
    const latest = await client.callTool({ name: "read_feedback", arguments: { batchId } });
    assert.equal(JSON.parse(latest.content[0].text).annotations[0].status, "open");
    const rejected = await client.callTool({ name: "read_feedback", arguments: { batchId: "../outside" } }); assert.equal(rejected.isError, true);
  } finally { await client.close(); }
  const markdown = await readFile(join(root, batchId, "feedback.md"), "utf8"); assert.match(markdown, /Synthetic test comment/);
});

test("invalid captures and traversal cannot create or read arbitrary files", async () => {
  const repository = await new FeedbackRepository(root).init();
  const { batchId } = await repository.create("Validation test");
  await assert.rejects(repository.save(batchId, annotation, "not-png"), /PNG/);
  await assert.rejects(repository.save(batchId, { ...annotation, kind: "region" }, png), /coordinates/);
  await assert.rejects(repository.save(batchId, { ...annotation, comment: "" }, png));
  await assert.rejects(repository.read("../elsewhere"), /Invalid batch/);
  const outside = await mkdtemp(join(tmpdir(), "feedback-outside-"));
  await symlink(outside, join(root, "linked")); await assert.rejects(repository.read("linked"), /Linked/);
  await writeFile(join(outside, "secret.txt"), "test-only");
  const batch = await repository.read(batchId);
  batch.annotations.push({ id: "2e920970-861a-46a8-8f8c-1b044f8ed2f6", screenshot: "../../secret.txt" });
  await writeFile(join(root, batchId, "feedback.json"), JSON.stringify(batch));
  await assert.rejects(repository.screenshot(batchId, batch.annotations[0].id), /not found/);
});

test("native protocol rejects oversized and incomplete frames", async () => {
  const oversized = Buffer.alloc(4); oversized.writeUInt32LE(18000000);
  const large = await run("feedback-native", ["--root", root], oversized); assert.equal(large.code, 1); assert.match(large.stderr, /limit/);
  const partial = await run("feedback-native", ["--root", root], Buffer.from([50, 0, 0, 0, 123])); assert.equal(partial.code, 1); assert.match(partial.stderr, /Incomplete/);
  const unknown = await native({ action: "exec", command: "anything" }); assert.equal(unknown.ok, false);
});


test("installer relocates the launcher, is repeatable, and refuses conflicting installs", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "feedback-install-"));
  const prepared = join(scratch, "Documents/package");
  const destination = join(scratch, "Chrome/NativeMessagingHosts");
  const runtime = join(scratch, "Application Support/Page Feedback");
  const script = (name) => fileURLToPath(new URL(`../scripts/${name}`, import.meta.url));
  const invoke = (file, args) => execFileSync(process.execPath, [file, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10000 });
  invoke(script("prepare-feedback.mjs"), ["--out", prepared, "--root", join(scratch, "inbox")]);
  const args = ["--package", prepared, destination, runtime];
  invoke(script("install-feedback-host.mjs"), args);
  invoke(script("install-feedback-host.mjs"), args);
  const manifest = JSON.parse(await readFile(join(destination, "com.browse_tool.page_feedback.json"), "utf8"));
  assert.equal(manifest.path, join(runtime, "feedback-native-host"));
  const response = execFileSync(manifest.path, [], { input: frame({ action: "list" }), timeout: 10000 });
  assert.equal(JSON.parse(response.subarray(4)).ok, true);
  await writeFile(manifest.path, "existing unrelated installation");
  assert.throws(() => invoke(script("install-feedback-host.mjs"), args), /Refusing to replace/);
  assert.equal(await readFile(manifest.path, "utf8"), "existing unrelated installation");
});
