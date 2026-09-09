import { mkdir, readdir, realpath, lstat, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { openBatch } from "./annotation-store.js";

const rect = z.object({ x: z.number().finite(), y: z.number().finite(), width: z.number().nonnegative(), height: z.number().nonnegative() });
const capture = z.object({
  kind: z.enum(["element", "region", "page"]), comment: z.string().trim().min(1).max(10000),
  context: z.object({ url: z.string().url().max(8192), title: z.string().max(2000), viewport: z.object({ width: z.number().positive(), height: z.number().positive(), devicePixelRatio: z.number().positive() }), scroll: z.object({ x: z.number().finite(), y: z.number().finite() }) }),
  target: z.object({ selector: z.string().max(8000).optional(), tag: z.string().max(100).optional(), text: z.string().max(2000).optional(), html: z.string().max(8000).optional(), rect: rect.optional() }),
});
const attachment = z.object({ id: z.string().uuid(), state: z.enum(["matched", "stale", "unverified", "snapshot"]), reason: z.string().max(500).optional(), checkedAt: z.string().datetime() });

export class FeedbackRepository {
  constructor(root) {
    if (!root || typeof root !== "string") throw new Error("A feedback root directory is required.");
    this.root = resolve(root);
  }
  async init() { await mkdir(this.root, { recursive: true, mode: 0o700 }); this.root = await realpath(this.root); return this; }
  async directory(batchId) {
    if (typeof batchId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,120}$/.test(batchId)) throw new Error("Invalid batch ID.");
    const path = join(this.root, batchId);
    if ((await lstat(path)).isSymbolicLink() || await realpath(path) !== path) throw new Error("Linked feedback directories are not allowed.");
    return path;
  }
  async file(batchId, filename) {
    const dir = await this.directory(batchId);
    const path = join(dir, filename);
    if (await realpath(path) !== path) throw new Error("Linked feedback files are not allowed.");
    return path;
  }
  async read(batchId) {
    const data = JSON.parse(await readFile(await this.file(batchId, "feedback.json"), "utf8"));
    if (data.version !== 1 || !Array.isArray(data.annotations)) throw new Error("Unsupported feedback format.");
    return data;
  }
  async list(offset = 0, limit = 20) {
    const names = (await readdir(this.root, { withFileTypes: true })).filter((entry) => entry.isDirectory() && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,120}$/.test(entry.name)).map((entry) => entry.name).sort().reverse();
    const batches = [];
    for (const name of names.slice(offset, offset + limit)) {
      try {
        const batch = await this.read(name);
        batches.push({ batchId: name, title: batch.title || name, createdAt: batch.createdAt, updatedAt: batch.updatedAt, comments: batch.annotations.length, open: batch.annotations.filter((item) => item.status === "open").length });
      } catch { /* Non-feedback directories are not inbox entries. */ }
    }
    return { batches, nextOffset: offset + limit < names.length ? offset + limit : null };
  }
  async create(title) {
    title = z.string().trim().min(1).max(200).parse(title);
    const batchId = randomUUID();
    const store = await openBatch({ out: join(this.root, batchId) });
    try { store.batch.title = title; await store.persist(); }
    finally { await store.close(); }
    return { batchId, title };
  }
  async mutate(batchId, change) {
    const dir = await this.directory(batchId);
    await this.file(batchId, "feedback.json");
    const store = await openBatch({ resume: dir });
    try { const result = await change(store); await store.persist(); return result; }
    finally { await store.close(); }
  }
  async save(batchId, input, pngData) {
    const parsed = capture.parse(input);
    if (Buffer.byteLength(JSON.stringify(parsed)) > 40000) throw new Error("Comment and target data are too large.");
    if (parsed.kind === "element" && (!parsed.target.selector || !parsed.target.tag || parsed.target.html === undefined || parsed.target.text === undefined || !parsed.target.rect)) throw new Error("Element details are missing.");
    if (parsed.kind === "region" && !parsed.target.rect) throw new Error("Region coordinates are missing.");
    if (typeof pngData !== "string" || !/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(pngData) || pngData.length > 16000000) throw new Error("A PNG screenshot is required (up to 12 MB).");
    const png = Buffer.from(pngData.slice("data:image/png;base64,".length), "base64");
    if (png.length < 33 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || png.subarray(12, 16).toString() !== "IHDR") throw new Error("Invalid PNG screenshot.");
    return this.mutate(batchId, async (store) => {
      if (await realpath(join(store.dir, "screenshots")) !== join(store.dir, "screenshots")) throw new Error("Linked screenshot directories are not allowed.");
      const id = randomUUID();
      const createdAt = new Date().toISOString();
      const item = { id, ...parsed, status: "open", createdAt, screenshot: `screenshots/${id}.png`, attachment: { state: parsed.kind === "element" ? "matched" : "snapshot", checkedAt: createdAt } };
      await writeFile(join(store.dir, item.screenshot), png, { flag: "wx", mode: 0o600 });
      store.batch.annotations.push(item);
      return { id };
    });
  }
  async status(batchId, id, status) {
    z.string().uuid().parse(id); z.enum(["open", "resolved"]).parse(status);
    return this.mutate(batchId, async (store) => {
      const item = store.batch.annotations.find((item) => item.id === id);
      if (!item) throw new Error("Comment not found.");
      item.status = status; item.updatedAt = new Date().toISOString();
      return { id, status };
    });
  }
  async attachments(batchId, results) {
    const checked = z.array(attachment).max(10000).parse(results);
    return this.mutate(batchId, async (store) => {
      for (const { id, ...state } of checked) {
        const item = store.batch.annotations.find((item) => item.id === id);
        if (item) item.attachment = state;
      }
      return { checked: checked.length };
    });
  }
  async screenshot(batchId, id) {
    z.string().uuid().parse(id);
    const batch = await this.read(batchId);
    const item = batch.annotations.find((item) => item.id === id);
    if (!item || !/^screenshots\/[a-zA-Z0-9-]+\.png$/.test(item.screenshot)) throw new Error("Screenshot not found.");
    return readFile(await this.file(batchId, item.screenshot));
  }
}

export async function nativeRequest(repository, request) {
  const pageArgs = () => ({ offset: z.number().int().nonnegative().parse(request.offset ?? 0), limit: z.number().int().min(1).max(20).parse(request.limit ?? 20) });
  switch (request.action) {
    case "list": { const { offset, limit } = pageArgs(); return repository.list(offset, limit); }
    case "create": return repository.create(request.title);
    case "get": {
      const { offset, limit } = pageArgs(); const batch = await repository.read(request.batchId);
      const page = { ...batch, annotations: [], nextOffset: null };
      for (const item of batch.annotations.slice(offset, offset + limit)) {
        page.annotations.push(item);
        if (Buffer.byteLength(JSON.stringify(page)) > 850000) { page.annotations.pop(); break; }
      }
      if (!page.annotations.length && offset < batch.annotations.length) throw new Error("A saved comment exceeds the transport limit.");
      page.nextOffset = offset + page.annotations.length < batch.annotations.length ? offset + page.annotations.length : null;
      return page;
    }
    case "save": return repository.save(request.batchId, request.annotation, request.screenshot);
    case "status": return repository.status(request.batchId, request.id, request.status);
    case "attachments": return repository.attachments(request.batchId, request.results);
    default: throw new Error("Unknown feedback operation.");
  }
}
