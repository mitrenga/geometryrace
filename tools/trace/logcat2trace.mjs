#!/usr/bin/env node
/**
 * logcat2trace — the GRT lines of a logcat dump as a trace file. The
 * instrumented original writes its trace to a file in persistentDataPath
 * (pulled with adb, no conversion needed); when it cannot open one it logs
 * every record as `GRT {...}` through Debug.Log instead, and this picks
 * them out of `adb logcat -d` — the header and the frame records, in
 * order, one JSON object per line (tools/trace/README.md). Runs are split
 * where a new header appears: `<out>-<run>.jsonl`.
 *
 * usage: node tools/trace/logcat2trace.mjs <logcat.txt> <out prefix>
 */
import fs from 'node:fs';

const [input, prefix] = process.argv.slice(2);
if (!input || !prefix) {
  console.log('usage: node tools/trace/logcat2trace.mjs <logcat.txt> <out prefix>');
  process.exit(2);
}
const lines = fs.readFileSync(input, 'utf8').split('\n');
let run = 0, out = [], frames = 0;
const flush = () => {
  if (out.length) {
    const file = `${prefix}-${run}.jsonl`;
    fs.writeFileSync(file, out.join('\n')+'\n');
    console.log(`${file}: ${frames} frames`);
  }
  out = [];
  frames = 0;
};
for (const line of lines) {
  const m = /GRT (\{.*\})\s*$/.exec(line);
  if (!m) continue;
  let o;
  try { o = JSON.parse(m[1]); } catch (e) { continue; }
  if (o.trace) {
    flush();
    run = o.run || run+1;
  } else if (typeof o.f == 'number') {
    frames++;
  }
  out.push(JSON.stringify(o));
}
flush();
