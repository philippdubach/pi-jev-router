// Catalog parsing — run: node --experimental-strip-types tests/catalog.test.ts
import { readFileSync } from "node:fs";
import { normalizeCatalog, loadCatalog, BOOTSTRAP_MODELS, CATALOG_TTL_MS } from "../src/catalog.ts";

let failed = 0;
const check = (name: string, ok: boolean) => {
  console.log(ok ? "PASS" : "FAIL", name);
  if (!ok) failed++;
};

const raw = JSON.parse(readFileSync(new URL("./fixtures/catalog-sample.json", import.meta.url), "utf8"));
const models = normalizeCatalog(raw);

check("drops malformed records", models.length === 4);

const sonnet = models.find((m) => m.id === "anthropic/claude-sonnet-5")!;
check("parses context length", sonnet.contextLength === 1000000);
check("parses prompt price", sonnet.promptPrice === 0.000002);
check("parses completion price", sonnet.completionPrice === 0.00001);
check("detects tool support", sonnet.supportsTools === true);
check("detects reasoning support", sonnet.supportsReasoning === true);
check("parses modalities", sonnet.inputModalities.includes("image"));
check("parses aa coding index", sonnet.aa?.coding === 71.5);
check("null expiry when absent", sonnet.expiresAt === null);

const noTools = models.find((m) => m.id === "some/no-tools-model")!;
check("records missing tool support", noTools.supportsTools === false);
check("null aa when absent", noTools.aa === null);

const expired = models.find((m) => m.id === "some/expired-model")!;
check("parses expiry to epoch ms", expired.expiresAt === Date.parse("2020-01-01T00:00:00Z"));

check("empty input yields empty list", normalizeCatalog({}).length === 0);
check("null input yields empty list", normalizeCatalog(null).length === 0);

check("bootstrap has three models", BOOTSTRAP_MODELS.length === 3);
check("bootstrap models priced", BOOTSTRAP_MODELS.every((m) => m.promptPrice > 0));

const failingFetch = async () => { throw new Error("network down"); };
const boot = await loadCatalog({ fetchImpl: failingFetch as any, cachePath: "/nonexistent/path.json" });
check("falls back to bootstrap", boot.source === "bootstrap" && boot.models.length === 3);

check("ttl is twelve hours", CATALOG_TTL_MS === 12 * 60 * 60 * 1000);

process.exit(failed ? 1 : 0);
