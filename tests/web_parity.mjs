// Checks that the browser engine (docs/engine.js) reaches exactly the same verdicts,
// evidence and errors as investigate.py, on the built-in scenarios and on random data.
// Run: node tests/web_parity.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { investigate, SCENARIOS } from '../docs/engine.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-parity-'));

function runPython(data) {
  const file = path.join(tmp, 'case.json');
  fs.writeFileSync(file, JSON.stringify(data));
  try {
    return { ok: JSON.parse(execFileSync(python, ['investigate.py', '--input', file], { cwd: root, stdio: 'pipe' }).toString()) };
  } catch (e) {
    return { error: e.stderr.toString().trim().replace(/^Investigation stopped: /, '') };
  }
}

async function runJs(data) {
  try { return { ok: await investigate(data) }; } catch (e) { return { error: e.message }; }
}

const close = (a, b) => {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-9;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => close(x, b[i]));
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
    return close(ka, kb) && ka.every((k) => close(a[k], b[k]));
  }
  return a === b;
};

let seed = 12345;
const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
function randomCase() {
  const data = {};
  const segs = int(1, 4);
  for (let s = 0; s < segs; s++) {
    const n = int(1, 200), m = int(1, 200);
    data[`seg${s}`] = [[int(0, n), n], [int(0, m), m]];
  }
  return data;
}

const cases = [
  ...Object.entries(SCENARIOS).map(([name, data]) => [name, data]),
  ['invalid: empty', {}],
  ['invalid: zero total', { a: [[0, 0], [1, 2]] }],
  ['invalid: passed > total', { a: [[5, 4], [1, 2]] }],
  ...Array.from({ length: 300 }, (_, i) => [`random #${i + 1}`, randomCase()])
];

let failures = 0;
const verdicts = {};
for (const [name, data] of cases) {
  const py = runPython(data);
  const js = await runJs(data);
  const same = py.error !== undefined ? js.error === py.error : js.ok && close(py.ok, js.ok);
  if (!same) {
    failures++;
    console.error(`MISMATCH ${name}\n  data: ${JSON.stringify(data)}\n  python: ${JSON.stringify(py)}\n  js: ${JSON.stringify(js)}`);
  } else {
    const v = py.error ? 'error' : py.ok.verdict;
    verdicts[v] = (verdicts[v] || 0) + 1;
  }
}
console.log(`${cases.length - failures}/${cases.length} cases identical`, verdicts);
process.exit(failures ? 1 : 0);
