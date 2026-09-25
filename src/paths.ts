/**
 * Where the router keeps its state.
 *
 * `PI_JEV_ROUTER_DIR` overrides the location. Tests set it so they never
 * write to the real ledger: an earlier mock run left three fake auto-mode
 * decisions in the ledger that later analysis had to exclude by hand.
 */
import { join } from "node:path";
import { homedir } from "node:os";

export const ROUTER_DIR = process.env.PI_JEV_ROUTER_DIR || join(homedir(), ".pi", "agent", "jev-router");
