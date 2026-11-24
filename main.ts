// Launch-Odds Radar v13-mellow — entry program (Node 22+, standard library only).
//
// Reads the sealed snapshot from /input/snapshot.json (or --input <file|dir>),
// scores every board-rule pre-token protocol with the model in lib/model.ts,
// writes the ranked board to /output/board.json, the dashboard's data to
// /output/data.js, copies this repository's dashboard/ and screenshots/ to
// /output, and writes /output/dossier.json with the vendored make.fun library.
//
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

/** The scorer's own caps (reference/gate.json): the text cap shapes the bytes, the rest refuse. */
const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** --name <value> out of the arguments, or the fallback. */
function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const withEquals = process.argv.find((a) => a.startsWith(`--${name}=`));
  return withEquals === undefined ? fallback : withEquals.slice(name.length + 3);
}

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`token radar: no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input\n`);
  process.exit(2);
}
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshotText = readFileSync(inputFile, 'utf8');
const snapshotSha = createHash('sha256').update(snapshotText, 'utf8').digest('hex');
const snapshot = parseSnapshot(snapshotText);
const { board, radar } = buildRadar(snapshot);
radar.snapshot_sha = snapshotSha;
const issue = boardIssue(board, snapshot);
if (issue !== null) {
  process.stderr.write(`token radar: the model wrote a board the gate refuses: ${issue}\n`);
  process.exit(1);
}
// The ledger must account for every protocol in the snapshot, no exceptions.
const ledgerTotal = radar.ledger.reduce((a, l) => a + l.count, 0);
if (ledgerTotal !== snapshot.protocols.length) {
  process.stderr.write(`token radar: ledger counts ${ledgerTotal} of ${snapshot.protocols.length} protocols\n`);
  process.exit(1);
}

const boardJson = `${JSON.stringify({ rows: board })}\n`;
const dataJs = dataScript(radar);
for (const [label, text] of [['board.json', boardJson], ['data.js', dataJs]] as const) {
  if (text.includes('http')) {
    process.stderr.write(`token radar: ${label} names a network address\n`);
    process.exit(1);
  }
}

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), boardJson);
writeFileSync(join(out, 'data.js'), dataJs);

/** Copy one directory's regular files into `to`, skipping names that start with a dot. */
function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));
const shots = copyFiles(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3) {
  process.stderr.write(`token radar: screenshots/ holds ${shots.length} image${shots.length === 1 ? '' : 's'}: hand in 3, the board, a detail view and a filtered view\n`);
  process.exit(1);
}
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) {
    process.stderr.write(`token radar: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters\n`);
    process.exit(1);
  }
}

// The dossier is written last: the scorer rebuilds it from this /output and compares bytes.
writeFileSync(join(out, 'dossier.json'), buildDossier(out, { text_max_bytes: TEXT_MAX_BYTES, screenshots: SCREENSHOT_CAPS, dashboard: { max_files: 400, max_bytes: 4_194_304 } }));

const farm = board.filter((r) => r.verdict === 'Farm').length;
const thin = board.filter((r) => r.verdict === 'Thin').length;
const skip = board.filter((r) => r.verdict === 'Skip').length;
process.stdout.write(
  `token radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${board.length} rows scored\n` +
    `token radar: snapshot sha256 ${snapshotSha}\n` +
    `token radar: verdicts Farm ${farm} / Thin ${thin} / Skip ${skip}; top ${board[0]!.name} $${board[0]!.implied_value_usd.toLocaleString('en-US')}\n` +
    `token radar: LOO x${radar.tests.loo.toFixed(3)} WF x${radar.tests.wf.toFixed(3)} AUC ${radar.tests.auc5fold.toFixed(3)} Brier ${radar.tests.brier5fold.toFixed(3)}\n` +
    `token radar: wrote ${join(out, 'board.json')}, ${join(out, 'data.js')}, ${join(out, 'dashboard')} (3 files), ${join(out, 'screenshots')} (${shots.length} images) and ${join(out, 'dossier.json')}\n`,
);
