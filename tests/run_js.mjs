// Runs the browser app's conversion engine (assets/converter.js) under Node, with the
// same arguments and output files as cli/sie_to_sbr.py, so the two can be compared.
//
//   node tests/run_js.mjs SOURCE OUTPUT.xml [--sample] [--sub-id unknown|keep|N]
//                         [--tz ZONE] [--nul strip|replace] [--owner NUMBERS]
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const S = require('../assets/converter.js');
const Z = require('../assets/zip.js');

function parseArgs(argv) {
  const opts = { sample: false, subId: 'unknown', tz: null, nul: 'strip', owner: null };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--sample') opts.sample = true;
    else if (a === '--sub-id') opts.subId = argv[++i];
    else if (a === '--tz') opts.tz = argv[++i];
    else if (a === '--nul') opts.nul = argv[++i];
    else if (a === '--owner') opts.owner = argv[++i];
    else pos.push(a);
  }
  if (pos.length !== 2) throw new Error('usage: node tests/run_js.mjs SOURCE OUTPUT.xml [options]');
  return [pos[0], pos[1], opts];
}

export async function openSource(p) {
  if (fs.statSync(p).isDirectory()) {
    const files = [];
    const walk = (dir, rel) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name), r = rel ? rel + '/' + e.name : e.name;
        if (e.isDirectory()) walk(full, r);
        else files.push({ path: r, size: fs.statSync(full).size, read: async () => new Uint8Array(fs.readFileSync(full)) });
      }
    };
    walk(p, '');
    return S.sourceFromFiles(files, path.basename(p));
  }
  return S.sourceFromZip(await Z.openZip(await fs.openAsBlob(p)), path.basename(p));
}

function fileSink(file) {
  const fd = fs.openSync(file, 'w');
  let pending = [], size = 0, bytes = 0;
  const flush = () => {
    if (!pending.length) return;
    const buf = Buffer.from(pending.join(''), 'utf8');
    fs.writeSync(fd, buf);
    bytes += buf.length;
    pending = [];
    size = 0;
  };
  return {
    get bytes() { return bytes; },
    async write(s) { pending.push(s); size += s.length; if (size > 8 << 20) flush(); },
    async close() { flush(); fs.closeSync(fd); },
  };
}

async function main() {
  const [source, output, opts] = parseArgs(process.argv.slice(2));
  const err = S.checkTimeZone(opts.tz);
  if (err) throw new Error(err);
  const src = await openSource(source);
  const loaded = await S.load(src);
  const tmp = output + '.partial';
  const sink = fileSink(tmp);
  const result = await S.convert({ src, loaded, options: opts, sink });
  fs.renameSync(tmp, output);
  fs.writeFileSync(output.slice(0, -4) + '.manifest.csv', S.manifest(result));
  fs.writeFileSync(output.slice(0, -4) + '.report.txt', S.report(result, path.basename(output), sink.bytes));
  console.log('wrote %s: %d messages', output, result.chosen.length);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error('error: ' + e.message); process.exit(1); });
}
