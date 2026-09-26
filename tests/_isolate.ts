/**
 * Import this first in any test that touches router state.
 *
 * ES modules evaluate in import order, so this runs before `src/paths.ts`
 * reads the variable. A test run directly, outside `npm test`, once reaped
 * two real board tasks and left two cancelled test tasks behind.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.PI_JEV_ROUTER_DIR) {
  process.env.PI_JEV_ROUTER_DIR = mkdtempSync(join(tmpdir(), "pi-jev-test-"));
}
export const TEST_DIR: string = process.env.PI_JEV_ROUTER_DIR;
