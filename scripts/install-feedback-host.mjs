import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

const [flag, packagePath, destinationArg, runtimeArg] = process.argv.slice(2);
if (flag !== "--package" || !packagePath) throw new Error("Usage: install-feedback-host.mjs --package directory [native-host-directory] [runtime-directory]");
const prepared = resolve(packagePath);
const destination = resolve(destinationArg || join(homedir(), "Library/Application Support/Google/Chrome/NativeMessagingHosts"));
const runtime = resolve(runtimeArg || join(homedir(), "Library/Application Support/Page Feedback"));
const name = "com.browse_tool.page_feedback.json";
const manifest = JSON.parse(await readFile(join(prepared, name), "utf8"));
const launcher = await readFile(join(prepared, "feedback-native-host"), "utf8");
// Chrome could not launch a shell script from Documents in the installed-profile test.
// Keep the executable in Application Support; the inbox remains user-selected.
manifest.path = join(runtime, "feedback-native-host");
const content = JSON.stringify(manifest, null, 2) + "\n";
const target = join(destination, name);
const existing = async (path) => {
  try { return await readFile(path, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
};
for (const [path, expected] of [[target, content], [manifest.path, launcher]]) {
  const found = await existing(path);
  if (found !== null && found !== expected) throw new Error(`Refusing to replace an existing installation: ${path}`);
}
await mkdir(runtime, { recursive: true, mode: 0o700 });
await mkdir(destination, { recursive: true });
if (await existing(manifest.path) === null) await writeFile(manifest.path, launcher, { flag: "wx", mode: 0o755 });
await chmod(manifest.path, 0o755);
if (await existing(target) === null) await writeFile(target, content, { flag: "wx", mode: 0o600 });
console.log(`Installed: ${target}`);
