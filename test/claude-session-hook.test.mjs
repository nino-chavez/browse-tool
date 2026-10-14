import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const hook = fileURLToPath(new URL('../bin/browse-session-hook', import.meta.url));
const modulePath = fileURLToPath(new URL('../lib/session.js', import.meta.url));
function run(payload, env) {
  return spawnSync('python3', [hook], { input: JSON.stringify(payload), env: {...process.env, ...env}, encoding: 'utf8', timeout: 5000 });
}
test('startup and folder changes pass a stable ID into separate tool shells', () => {
  const dir = mkdtempSync(join(tmpdir(),'claude-browser-hook-'));
  const envFile = join(dir,'env.sh');
  try {
    writeFileSync(envFile, 'export EXISTING_SETTING=preserved\n');
    for (const event of ['SessionStart','CwdChanged']) {
      const r = run({session_id:'claude-hook-chat',hook_event_name:event}, {CLAUDE_ENV_FILE:envFile});
      assert.equal(r.status,0,r.stderr);
      if (event === 'SessionStart') assert.equal(JSON.parse(r.stdout).hookSpecificOutput.hookEventName,event);
      const env = {...process.env};
      for (const k of ['BROWSE_SESSION','CLAUDE_CODE_SESSION_ID','CODEX_COMPANION_SESSION_ID','CODEX_THREAD_ID']) delete env[k];
      const shell = spawnSync('/bin/bash',['-c',`source "$1"; node --input-type=module -e 'import {sessionId} from "${modulePath}"; console.log(sessionId())'`, 'hook-test', envFile], {env, encoding:'utf8', timeout:5000, stdio:['ignore','pipe','pipe']});
      assert.equal(shell.status,0,shell.stderr);
      assert.equal(shell.stdout.trim(),'claude-hook-chat');
    }
    assert.match(readFileSync(envFile,'utf8'),/EXISTING_SETTING=preserved/);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
test('invalid input cannot write shell code; missing env file fails visibly', () => {
  const dir = mkdtempSync(join(tmpdir(),'claude-browser-hook-'));
  const envFile = join(dir,'env.sh');
  try {
    writeFileSync(envFile,'unchanged');
    const r = run({session_id:"bad'; touch /tmp/unwanted",hook_event_name:'SessionStart'}, {CLAUDE_ENV_FILE:envFile});
    assert.equal(r.status,1); assert.equal(readFileSync(envFile,'utf8'),'unchanged');
    const missing = run({session_id:'valid-chat',hook_event_name:'SessionStart'}, {CLAUDE_ENV_FILE:''});
    assert.equal(missing.status,1); assert.match(missing.stderr,/unavailable/);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
