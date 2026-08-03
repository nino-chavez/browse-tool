// Which browser instance this process addresses, and where its state lives.
//
// The port IS a browser's identity everywhere else in this tool: portOwners()
// verifies by port, browse-start refuses a port something else holds, browse-stop
// kills the port's owner. State has to be keyed the same way.
//
// It used to be one global $TMPDIR/browse-tool-state.json, which made every
// concurrent session share a single record. The most recent browse-start anywhere
// on the machine overwrote it, so a browse-stop elsewhere read a pid AND a port
// that were never its own. Scoping the pid to the port (the previous fix) closed
// half of that: session A stopping while B held a different port would still read
// B's port from the shared file, find B's pid as its legitimate owner, and kill it
// — with nothing to flag, because the recorded pid did own the recorded port.
// Keying the file by port makes concurrent instances independent by construction.
//
// Consequence worth knowing: a session driving a non-default port must say so on
// every command, via BROWSE_PORT. browse-start prints the export line.

import { readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const DEFAULT_PORT = 9222;

/** Port for this process: an explicit --port, else BROWSE_PORT, else the default. */
export function resolvePort(explicit) {
  const n = Number(explicit ?? process.env.BROWSE_PORT);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_PORT;
}

export function stateFile(port = resolvePort()) {
  return join(tmpdir(), `browse-tool-state-${port}.json`);
}

export function readState(port = resolvePort()) {
  const f = stateFile(port);
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, "utf8"));
  } catch {
    return null;
  }
}
