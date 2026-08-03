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

/**
 * Port for this process: an explicit --port, else BROWSE_PORT, else the default.
 *
 * A value that was PROVIDED but does not parse is fatal, never a fallback. The
 * default port is a live browser other sessions are working in, so silently
 * redirecting there is the most dangerous possible response to a typo:
 * `BROWSE_PORT=9223x browse-stop` would kill the shared Chrome and report
 * success. Absent is a default; malformed is an error.
 *
 * Note `--port` with no value: parseArgs yields boolean true, and Number(true)
 * is 1 — a perfectly valid-looking port. Rejected explicitly.
 */
export function resolvePort(explicit) {
  const raw = explicit ?? process.env.BROWSE_PORT;
  if (raw === undefined || raw === null || raw === "") return DEFAULT_PORT;

  const source = explicit === undefined ? "BROWSE_PORT" : "--port";
  const n = typeof raw === "boolean" ? NaN : Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    console.error(
      `${source}=${raw === true ? "(no value)" : raw} is not a port number (1-65535).\n` +
        `Refusing to fall back to ${DEFAULT_PORT}: that is a browser other sessions may be using.`,
    );
    process.exit(1);
  }
  return n;
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
