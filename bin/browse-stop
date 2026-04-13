#!/usr/bin/env node
import { unlinkSync, existsSync } from "node:fs";
import { STATE_FILE, readState } from "../lib/connect.js";

const state = readState();
if (!state?.pid) {
  console.log("No running Chrome tracked.");
  process.exit(0);
}

try {
  process.kill(state.pid, "SIGTERM");
  console.log(`Stopped Chrome (pid ${state.pid}).`);
} catch (err) {
  console.error(`Kill failed: ${err.message}`);
}

if (existsSync(STATE_FILE)) unlinkSync(STATE_FILE);
