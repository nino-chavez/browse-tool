import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { sessionPage, createSessionPage, allLeases } from '../lib/session.js';
import * as sessions from '../lib/session.js';

function fakeBrowser() {
  let count = 0;
  const tabs = [];
  const contexts = [];
  const makePage = async (contextId = null) => {
    const page = {
      id: `TAB${++count}`, contextId, closed: false,
      bringToFront: async () => {},
      close: async () => { page.closed = true; },
      createCDPSession: async () => ({
        send: async () => ({ targetInfo: { targetId: page.id } }), detach: async () => {},
      }),
    };
    tabs.push(page);
    return page;
  };
  return {
    pages: async () => tabs.filter(p => !p.closed),
    newPage: () => makePage(),
    browserContexts: () => contexts,
    createBrowserContext: async () => {
      const ctx = { id: `CTX${contexts.length}`, newPage: () => makePage(ctx.id),
        pages: async () => tabs.filter(p => !p.closed && p.contextId === ctx.id),
        close: async () => { contexts.splice(contexts.indexOf(ctx), 1); },
      };
      contexts.push(ctx);
      return ctx;
    },
  };
}
const sessionModule = new URL('../lib/session.js', import.meta.url).href;
test('separate tool shells resolve the same Codex chat ID', () => {
  const env = { ...process.env, CODEX_THREAD_ID: 'codex-chat-stable' };
  for (const k of ['BROWSE_SESSION','CLAUDE_CODE_SESSION_ID','CODEX_COMPANION_SESSION_ID']) delete env[k];
  const run = () => spawnSync('/bin/sh', ['-c', `node --input-type=module -e 'import {sessionId} from "${sessionModule}"; console.log(sessionId())'`], { env, encoding: 'utf8', timeout: 5000, stdio: ['ignore','pipe','pipe'] });
  const a = run(); const b = run();
  assert.equal(a.status, 0, a.stderr); assert.equal(b.status, 0, b.stderr);
  assert.equal(a.stdout.trim(), 'codex-chat-stable');
  assert.equal(b.stdout, a.stdout);
});

test('reuse, explicit extra tabs, cleanup, isolation and unrelated tabs', async () => {
  const id = `lifecycle-test-${process.pid}`;
  const oldSession = process.env.BROWSE_SESSION;
  process.env.BROWSE_SESSION = id;
  const b = fakeBrowser();
  try {
    const unrelated = await b.newPage();
    const a = await sessionPage(b, { port: 9222, incognito: false });
    assert.equal(await sessionPage(b, { port: 9222, incognito: false }), a);
    const extra = await createSessionPage(b, { port: 9222, incognito: false });
    assert.equal(await sessionPage(b, { port: 9222, incognito: false }), extra);
    await extra.close();
    assert.equal(await sessionPage(b, { port: 9222, incognito: false }), a, 'recover an older owned tab instead of creating another');
    const incognito = await sessionPage(b, { port: 9222, incognito: true });
    const remote = await sessionPage(b, { port: 9333, incognito: false });
    assert.notEqual(remote, extra, 'a lease for another port must not be reused');
    // Restore local port to exercise cleanup without destroying its older records.
    await sessionPage(b, { port: 9222, incognito: false });
    const other = await b.newPage();
    // Real public ownership record from another session.
    process.env.BROWSE_SESSION = id + '-other';
    const otherOwned = await sessionPage(b, { port: 9222, incognito: false });
    process.env.BROWSE_SESSION = id;
    assert.equal(typeof sessions.closeSessionPages, 'function');
    const result = await sessions.closeSessionPages(b, { port: 9222 });
    assert.equal(result.closed, 2);
    assert.equal(a.closed, true); assert.equal(extra.closed, true); assert.equal(incognito.closed, true);
    assert.equal(b.browserContexts().length, 0, 'empty owned incognito context is released');
    assert.equal(remote.closed, false); assert.equal(unrelated.closed, false); assert.equal(other.closed, false);
    assert.equal(otherOwned.closed, false);
    assert.ok(allLeases().some(l => l.id === id && l.port === 9333));
    assert.equal(allLeases().filter(l => l.id === id && l.port === 9222).length, 0);
    const again = await sessions.closeSessionPages(b, { port: 9222 });
    assert.equal(again.closed, 0, 'cleanup is idempotent');
    await sessions.clearLeasesForPort(9222, { sessionOnly: true });
    assert.ok(allLeases().some(l => l.id === id && l.port === 9333), 'stop cleanup must preserve another port');
    await sessions.clearLeasesForPort(9333, { sessionOnly: true });
    assert.equal(allLeases().filter(l => l.id === id).length, 0);
  } finally {
    for (const l of allLeases().filter(l => l.id.startsWith(id))) rmSync(join(homedir(), '.browse-tool', 'leases', l.file), { force: true });
    if (oldSession === undefined) delete process.env.BROWSE_SESSION; else process.env.BROWSE_SESSION = oldSession;
  }
});

test('cleanup keeps Chrome alive when every tab belongs to this session', async () => {
  const id = `last-tab-test-${process.pid}`;
  const old = process.env.BROWSE_SESSION; process.env.BROWSE_SESSION = id;
  const b = fakeBrowser();
  try {
    const own = await sessionPage(b, { port: 9222, incognito: false });
    assert.equal(typeof sessions.closeSessionPages, 'function');
    await sessions.closeSessionPages(b, { port: 9222 });
    assert.equal(own.closed, true);
    assert.equal((await b.pages()).length, 1);
    assert.equal(allLeases().filter(l => l.id === id).length, 0);
  } finally {
    for (const l of allLeases().filter(l => l.id === id)) rmSync(join(homedir(), '.browse-tool','leases',l.file), {force:true});
    if (old === undefined) delete process.env.BROWSE_SESSION; else process.env.BROWSE_SESSION = old;
  }
});


test('concurrent commands retain every owned tab for cleanup', async () => {
  const id = `concurrent-tabs-test-${process.pid}`;
  const old = process.env.BROWSE_SESSION; process.env.BROWSE_SESSION = id;
  const b = fakeBrowser();
  try {
    const pages = await Promise.all(Array.from({ length: 12 }, () => createSessionPage(b, { port: 9222, incognito: false })));
    const lease = allLeases().find(l => l.id === id);
    assert.equal(sessions.ownedTabs(lease).length, pages.length);
    const result = await sessions.closeSessionPages(b, { port: 9222 });
    assert.equal(result.closed, pages.length);
    assert.ok(pages.every(p => p.closed));
  } finally {
    for (const l of allLeases().filter(l => l.id === id)) rmSync(join(homedir(), '.browse-tool','leases',l.file), {force:true});
    if (old === undefined) delete process.env.BROWSE_SESSION; else process.env.BROWSE_SESSION = old;
  }
});
