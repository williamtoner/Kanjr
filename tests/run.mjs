/**
 * Tiny test runner. Usage: node tests/run.mjs [filter]
 *
 * Imports every *.test.mjs file next to this one, runs the functions in its
 * exported `tests` object, prints one line per failure and a summary, and
 * exits with code 1 when anything failed. Node 12 compatible (no node --test,
 * no top-level await).
 */
import { readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const filter = process.argv[2] || '';
const files = readdirSync(here).filter((f) => f.endsWith('.test.mjs')).sort();

let passed = 0;
let failed = 0;
const failures = [];

function runFile(file) {
  return import(pathToFileURL(join(here, file)).href).then((mod) => {
    const tests = mod.tests || {};
    const names = Object.keys(tests).filter((n) => n.includes(filter));
    console.log(`\n${file}  (${names.length} tests)`);
    return names.reduce((chain, name) => chain.then(() => {
      return Promise.resolve()
        .then(() => tests[name]())
        .then(() => { passed++; console.log(`  ok   ${name}`); })
        .catch((err) => {
          failed++;
          failures.push({ file, name, err });
          console.log(`  FAIL ${name}`);
        });
    }), Promise.resolve());
  });
}

files.reduce((chain, file) => chain.then(() => runFile(file)), Promise.resolve())
  .then(() => {
    for (const f of failures) {
      console.log(`\n--- ${f.file} › ${f.name}`);
      console.log(f.err && f.err.stack ? f.err.stack : String(f.err));
    }
    console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} total`);
    process.exit(failed ? 1 : 0);
  })
  .catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  });
