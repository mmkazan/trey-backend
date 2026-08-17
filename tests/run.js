#!/usr/bin/env node
// tests/run.js — the whole suite. `node tests/run.js` from the repo root.
//
// WHY THESE LIVE IN THE REPO (17 Aug 2026)
// ----------------------------------------
// Trey had 285 passing tests. They were written into /tmp and regenerated each
// session, so by the time anyone looked for them they were gone — which meant
// a security fix touching 20 files had no regression net at all. Tests that
// aren't committed don't exist. These do.
//
// No dependencies, no framework, no build step: plain node, same as the rest of
// the repo. Add a file to tests/, export `run(t)`, and it is picked up.

const fs = require("fs");
const path = require("path");

let passed = 0, failed = 0;
const failures = [];

const t = {
  ok(cond, name) {
    if (cond) { passed++; }
    else { failed++; failures.push(name); console.log(`  ✗ ${name}`); }
  },
  eq(actual, expected, name) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    this.ok(a === e, `${name}  (got ${a}, expected ${e})`);
  },
  throws(fn, name) {
    try { fn(); this.ok(false, name + " (did not throw)"); }
    catch (e) { this.ok(true, name); }
  },
};

const files = fs.readdirSync(__dirname)
  .filter((f) => f.endsWith(".test.js"))
  .sort();

console.log(`\nTrey test suite — ${files.length} files\n${"=".repeat(46)}`);

for (const f of files) {
  const before = passed + failed;
  process.stdout.write(`\n${f}\n`);
  try {
    require(path.join(__dirname, f)).run(t);
  } catch (e) {
    failed++; failures.push(`${f} threw: ${e.message}`);
    console.log(`  ✗ SUITE THREW: ${e.message}`);
  }
  console.log(`  ${passed + failed - before} assertions`);
}

console.log(`\n${"=".repeat(46)}`);
console.log(`${passed} passed, ${failed} failed`);
if (failed) {
  console.log("\nFailures:");
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
console.log("");
