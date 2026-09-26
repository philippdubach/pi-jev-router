/**
 * The version of this package that the running process loaded.
 *
 * A pi session loads the extension once. A session started on 20 September
 * kept making decisions with that code for six days, and the ledger could not
 * show it. Every record now carries this value, and `/router status` compares
 * it with the checkout on disk.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");

export function readVersion(root: string = ROOT): string {
  try {
    return execFileSync("git", ["-C", root, "rev-parse", "--short", "HEAD"], {
      encoding: "utf8", timeout: 800, stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    try {
      return "v" + JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
    } catch {
      return "unknown";
    }
  }
}

export const LOADED_VERSION: string = readVersion();

/**
 * The `/router status` version line. Same version: report it once. Different:
 * name both and say to restart, so a stale session is never silent about it.
 */
export function versionLine(loaded: string, disk: string): string {
  return disk === loaded
    ? `version: ${loaded}`
    : `version: ${loaded} loaded, ${disk} on disk — restart pi to load it`;
}
