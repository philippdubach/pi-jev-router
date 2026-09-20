// Pareto frontier — run: node --experimental-strip-types tests/frontier.test.ts
import { dominates, nondominated, tangency, type Scored } from "../src/frontier.ts";

let failed = 0;
const check = (name: string, ok: boolean) => {
  console.log(ok ? "PASS" : "FAIL", name);
  if (!ok) failed++;
};

const s = (id: string, q: number, c: number, t: number): Scored => ({ id, q, c, t });

check("strictly better dominates", dominates(s("a", 0.9, 1, 1), s("b", 0.5, 1, 1)));
check("cheaper dominates", dominates(s("a", 0.5, 1, 1), s("b", 0.5, 2, 1)));
check("faster dominates", dominates(s("a", 0.5, 1, 1), s("b", 0.5, 1, 2)));
check("identical does not dominate", !dominates(s("a", 0.5, 1, 1), s("b", 0.5, 1, 1)));
check("mixed does not dominate", !dominates(s("a", 0.9, 5, 1), s("b", 0.5, 1, 1)));

const mixed = [
  s("cheap-weak", 0.30, 0.01, 10),
  s("mid", 0.60, 0.10, 20),
  s("strong-costly", 0.95, 1.00, 30),
  s("dominated", 0.50, 0.50, 40),
];
const f = nondominated(mixed).map((x) => x.id).sort();
check("keeps the three non-dominated", f.join(",") === "cheap-weak,mid,strong-costly");
check("drops the dominated one", !f.includes("dominated"));

check("empty input", nondominated([]).length === 0);
check("single item is its own frontier", nondominated([s("solo", 0.5, 1, 1)]).length === 1);

const allEqual = [s("a", 0.5, 1, 1), s("b", 0.5, 1, 1)];
check("ties are all non-dominated", nondominated(allEqual).length === 2);

const one = [s("only", 0.42, 3, 7)];
check("one dominator collapses the set", nondominated([...one, s("worse", 0.1, 9, 9)]).length === 1);

const frontier = nondominated(mixed);
// Selection is monotonic in lambda: quality first, then balance, then price.
// The mid/cheap crossover on this fixture sits at lambda ~= 5.08.
check("zero lambda picks strong", tangency(frontier, 0, 0)!.pick.id === "strong-costly");
check("mid lambda picks mid", tangency(frontier, 2.0, 0)!.pick.id === "mid");
check("high lambda picks cheap", tangency(frontier, 20.0, 0)!.pick.id === "cheap-weak");
check("empty frontier returns undefined", tangency([], 1, 1) === undefined);

const flatCost = [s("a", 0.2, 1, 1), s("b", 0.8, 1, 1)];
check("constant axis is inert", tangency(flatCost, 9, 9)!.pick.id === "b");

process.exit(failed ? 1 : 0);
