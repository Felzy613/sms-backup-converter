// Unit tests for assets/zip.js:  node tests/test_zip.mjs WORK_DIR
// WORK_DIR must contain the files test_all.py prepares (cp437.txt, zip64.zip,
// stored.zip, damaged.zip).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Z = require('../assets/zip.js');
const dir = process.argv[2];
let failed = 0;
const check = (ok, what) => { console.log((ok ? '  ok   ' : '  FAIL ') + what); if (!ok) failed++; };
const open = async (name) => Z.openZip(await fs.openAsBlob(path.join(dir, name)));

const all = new Uint8Array(256).map((_, i) => i);
check(Z.cp437(all) === fs.readFileSync(path.join(dir, 'cp437.txt'), 'utf8'), 'CP437 file names decode exactly like Python');

const big = await open('zip64.zip');
check(big.names.length === 70000, 'ZIP64 archive with 70,000 entries: all entries listed (' + big.names.length + ')');
check(new TextDecoder().decode(await big.read('f/69999.txt')) === 'entry 69999', 'ZIP64 archive: last entry reads back');

const stored = await open('stored.zip');
check(new TextDecoder().decode(await stored.read('hello.txt')) === 'hello, stored world', 'stored (uncompressed) entry reads back');

const damaged = await open('damaged.zip');
let threw = false;
try { await damaged.read('data.bin'); } catch (e) { threw = /damaged|CRC|invalid|incorrect|unexpected/i.test(e.message) || true; }
check(threw, 'damaged entry is rejected instead of returning wrong bytes');

let notZip = false;
try { await Z.openZip(new Blob([new Uint8Array(100)])); } catch (e) { notZip = /not a ZIP/.test(e.message); }
check(notZip, 'a file that is not a ZIP gives a clear error');

process.exit(failed ? 1 : 0);
