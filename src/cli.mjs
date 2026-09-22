#!/usr/bin/env node
// fact-gate CLI — exit 0 on pass, 1 on block (or on warn with --strict).
//
//   fact-gate --target cv.md --source profile.md
//   fact-gate --target cv.md --facts facts.json --jd job.md --config gate.json --json
//   cat cv.md | fact-gate --source profile.md

import { readFileSync } from 'node:fs';
import { verifyFacts, formatReport, VERSION } from './index.mjs';

const HELP = `fact-gate ${VERSION} — verify LLM-generated text against a source of truth

USAGE
  fact-gate --target <file|-> (--source <file> | --facts <json>) [options]

OPTIONS
  --target <file>    generated text to check ("-" or omitted = stdin)
  --source <file>    source of truth as prose
  --facts <file>     source of truth as JSON ({counts, years, employers, ...})
  --jd <file>        reference text the model was shown; figures quoted from it
                     are echoes, not self-claims
  --config <file>    JSON {allow_metrics, allow_facts, forbidden_phrases, warn_phrases}
  --nouns a,b,c      extra countable nouns for your domain
  --label <text>     identifier shown in the report
  --json             machine-readable result on stdout
  --strict           exit 1 on warn as well as block
  --quiet            print nothing on pass
  -h, --help         this text
  -v, --version      print version

EXIT CODES
  0  pass (or warn without --strict)      1  block (or warn with --strict)      2  usage error`;

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') out.help = true;
    else if (a === '-v' || a === '--version') out.version = true;
    else if (a === '--json' || a === '--strict' || a === '--quiet') out[a.slice(2)] = true;
    else if (a.startsWith('--')) { out[a.slice(2)] = argv[i + 1]; i++; }
    else out._.push(a);
  }
  return out;
}

function readOrDie(path, what) {
  try { return readFileSync(path, 'utf8'); }
  catch (e) { console.error(`fact-gate: cannot read ${what} "${path}": ${e.message}`); process.exit(2); }
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) { console.log(HELP); return 0; }
  if (args.version) { console.log(VERSION); return 0; }

  if (!args.source && !args.facts) { console.error('fact-gate: need --source and/or --facts\n\n' + HELP); return 2; }

  let target;
  if (!args.target || args.target === '-') {
    target = await new Promise((resolve) => {
      let s = ''; process.stdin.setEncoding('utf8');
      process.stdin.on('data', d => s += d); process.stdin.on('end', () => resolve(s));
    });
  } else target = readOrDie(args.target, 'target');

  const options = { label: args.label || args.target || 'stdin' };
  if (args.source) options.source = readOrDie(args.source, 'source');
  if (args.facts) { try { options.facts = JSON.parse(readOrDie(args.facts, 'facts')); } catch (e) { console.error(`fact-gate: --facts is not valid JSON: ${e.message}`); return 2; } }
  if (args.jd) options.jd = readOrDie(args.jd, 'jd');
  if (args.config) { try { options.config = JSON.parse(readOrDie(args.config, 'config')); } catch (e) { console.error(`fact-gate: --config is not valid JSON: ${e.message}`); return 2; } }
  if (args.nouns) options.nouns = String(args.nouns).split(',').map(s => s.trim()).filter(Boolean);

  let result;
  try { result = verifyFacts(target, options); }
  catch (e) { console.error(`fact-gate: ${e.message}`); return 2; }

  if (args.json) console.log(JSON.stringify(result, null, 2));
  else if (!(args.quiet && result.verdict === 'pass')) {
    const c = result.counts;
    console.log(`${result.verdict.toUpperCase()}  ${options.label} — ${c.total} claims: ${c.verified} verified, ${c.unsupported} unsupported, ${c.fabricated} fabricated`);
    if (result.verdict !== 'pass' || result.allowlist.unused.length) console.log('  ' + formatReport(result));
  }
  if (result.verdict === 'block') return 1;
  if (result.verdict === 'warn' && args.strict) return 1;
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('cli.mjs') || process.argv[1]?.endsWith('fact-gate')) {
  main().then(code => process.exit(code));
}
