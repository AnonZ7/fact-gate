#!/usr/bin/env node
// fact-gate CLI.
//
//   fact-gate --target cv.md --source profile.md
//   fact-gate --target pr-body.md --diff changes.diff
//   fact-gate --target pr-body.md --git origin/main
//   fact-gate --target README.md --facts .fact-gate.json --format github
//   fact-gate measure --facts facts.json          resolve measurements, print plain facts
//   fact-gate init                                write .fact-gate.json + print the hook snippet
//   fact-gate hook                                run as a Claude Code PreToolUse hook (stdin JSON)
//
// Exit 0 pass · 1 block (or warn with --strict) · 2 usage error.

import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { verifyFacts, formatReport, mergeFacts, VERSION } from './index.mjs';
import { factsFromDiff } from './diff.mjs';
import { resolveFacts, isMeasurement } from './facts.mjs';
import { hookMain, CONFIG_NAME, isProjectConfig, loadConfig } from './hook.mjs';
import { trust, trustFile } from './trust.mjs';
import { precommitMain } from './precommit.mjs';
import { randomUUID } from 'node:crypto';

function collectMeasurementKeys(facts) {
  const keys = [];
  for (const [k, v] of Object.entries(facts || {})) {
    if (k === 'counts' && v && typeof v === 'object') { for (const [ck, cv] of Object.entries(v)) if (isMeasurement(cv)) keys.push(`counts.${ck}`); }
    else if (Array.isArray(v)) v.forEach((x, i) => { if (isMeasurement(x)) keys.push(`${k}[${i}]`); });
    else if (isMeasurement(v)) keys.push(k);
  }
  return keys;
}

const HELP = `fact-gate ${VERSION} — verify what an AI wrote against what is true

USAGE
  fact-gate [check] --target <file|-> (--source <file> | --facts <json> | --diff <file> | --git <base>) [options]
  fact-gate measure --facts <json>       resolve every measurement, print plain facts as JSON
  fact-gate init [dir]                   write ${CONFIG_NAME} and print the Claude Code hook snippet
  fact-gate hook                         Claude Code PreToolUse hook (reads the hook JSON on stdin)
  fact-gate trust [config]               allow the hook to run this config's "cmd" measurements
  fact-gate pre-commit [--strict]        check STAGED files covered by .fact-gate.json; exit 1 on block

SOURCES OF TRUTH (combine freely)
  --source <file>    prose the text must agree with (a profile, a spec, a changelog entry)
  --facts <file>     JSON facts; any value may be a measurement: {"cmd"|"file"|"json", "pattern"}
  --diff <file|->    a unified diff or git --numstat output: its counts become facts
  --git <base>       run "git diff <base>" in cwd and use it as --diff: your WORKING TREE vs
                     <base>. Pass "origin/main HEAD" to compare commits only.
  --jd <file>        reference text the model was shown; figures echoed from it are not self-claims

TARGET
  --target <file>    text to check ("-" or omitted = stdin)
  --target-env VAR   read the text from an environment variable (PR bodies in CI)

OPTIONS
  --config <file>    JSON {allow_metrics, allow_facts, forbidden_phrases, warn_phrases}
  --nouns a,b,c      extra countable nouns for your domain
  --label <text>     identifier shown in the report
  --format <f>       text (default) | json | markdown | github (annotations + step summary)
  --json             same as --format json
  --strict           exit 1 on warn as well as block
  --quiet            print nothing on pass
  --ignore-code      drop fenced and inline code from the target (README examples are not claims)
  --no-measure       leave measurement specs in --facts unresolved (error if any are present)
  --no-color         plain output (also honours NO_COLOR)
  -h, --help  -v, --version

EXIT CODES
  0  pass (or warn without --strict)      1  block (or warn with --strict)      2  usage error`;

const BOOL_FLAGS = new Set(['json', 'strict', 'quiet', 'no-measure', 'no-color', 'ignore-code', 'help', 'version']);
const VALUE_FLAGS = new Set(['target', 'target-env', 'source', 'facts', 'diff', 'git', 'jd', 'config', 'nouns', 'label', 'format']);

export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h') out.help = true;
    else if (a === '-v') out.version = true;
    else if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split('=', 2);
      if (!BOOL_FLAGS.has(k) && !VALUE_FLAGS.has(k)) throw new UsageError(`unknown option --${k} (see --help)`);
      if (BOOL_FLAGS.has(k)) out[k] = inline == null ? true : inline !== 'false';
      else if (inline != null) out[k] = inline;
      else { out[k] = argv[i + 1]; i++; }
    } else out._.push(a);
  }
  return out;
}

const useColor = (args) => !args['no-color'] && !process.env.NO_COLOR && process.stdout.isTTY && (args.format || 'text') === 'text';
const paint = (on) => (code, s) => on ? `\x1b[${code}m${s}\x1b[0m` : s;

function readOrDie(path, what) {
  try { return readFileSync(path, 'utf8'); }
  catch (e) { throw new UsageError(`cannot read ${what} "${path}": ${e.message}`); }
}
function readJsonOrDie(path, what) {
  try { return JSON.parse(readOrDie(path, what)); }
  catch (e) { if (e instanceof UsageError) throw e; throw new UsageError(`${what} "${path}" is not valid JSON: ${e.message}`); }
}
class UsageError extends Error {}

async function readStdin() {
  return new Promise((resolve) => {
    let s = ''; process.stdin.setEncoding('utf8');
    process.stdin.on('data', d => s += d); process.stdin.on('end', () => resolve(s)); process.stdin.on('error', () => resolve(s));
  });
}

/** Markdown table for step summaries and PR comments. */
export function formatMarkdown(result, { measurements = [] } = {}) {
  const icon = { pass: '✅', warn: '⚠️', block: '⛔' }[result.verdict];
  const c = result.counts;
  const lines = [`### ${icon} fact-gate: ${result.verdict.toUpperCase()} — ${result.label || 'target'}`, '',
    `${c.total} claims · ${c.verified} verified · ${c.unsupported} unsupported · ${c.fabricated} fabricated`, ''];
  const rows = [];
  for (const x of result.fabricated) rows.push(['⛔ fabricated', x.kind, x.claim ?? x.value, x.reason || '']);
  for (const p of result.forbidden) rows.push(['⛔ forbidden', 'phrase', p, '']);
  for (const x of result.unsupported) rows.push(['⚠️ unsupported', x.kind, x.claim ?? x.value, x.reason || '']);
  for (const p of result.warnings) rows.push(['⚠️ phrase', 'phrase', p, '']);
  for (const x of result.verified) rows.push(['✅ verified', x.kind, x.claim ?? x.value, x.reason || '']);
  if (rows.length) {
    lines.push('| status | kind | claim | detail |', '|---|---|---|---|');
    for (const r of rows) lines.push(`| ${r.map(v => String(v).replace(/\|/g, '\\|').replace(/\n/g, ' ')).join(' | ')} |`);
  }
  for (const e of result.allowlist?.unused || []) lines.push('', `> allow-list entry \`${e}\` rescued nothing — stale, or hiding a fixed problem`);
  if (measurements.length) {
    lines.push('', '<details><summary>measured facts</summary>', '');
    for (const m of measurements) lines.push(`- \`${m.key}\` = **${Array.isArray(m.value) ? m.value.join(', ') : m.value}** (${m.via})`);
    lines.push('', '</details>');
  }
  return lines.join('\n') + '\n';
}

/** GitHub Actions annotations + step summary + outputs. */
function emitGithub(result, extras) {
  const esc = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  for (const x of result.fabricated) console.log(`::error title=fact-gate fabricated ${x.kind}::${esc(`"${x.claim ?? x.value}" — ${x.reason}`)}`);
  for (const p of result.forbidden) console.log(`::error title=fact-gate forbidden phrase::${esc(p)}`);
  for (const x of result.unsupported) console.log(`::warning title=fact-gate unsupported ${x.kind}::${esc(`"${x.claim ?? x.value}" — ${x.reason}`)}`);
  for (const p of result.warnings) console.log(`::warning title=fact-gate phrase::${esc(p)}`);
  const md = formatMarkdown(result, extras);
  const appendOrWarn = (file, text, what) => {
    try { appendFileSync(file, text); }
    catch (e) { console.log(`::warning title=fact-gate::could not write ${what} (${e.message})`); }
  };
  if (process.env.GITHUB_STEP_SUMMARY) appendOrWarn(process.env.GITHUB_STEP_SUMMARY, md, 'the step summary');
  if (process.env.GITHUB_OUTPUT) {
    const delim = `fg_${randomUUID()}`;
    appendOrWarn(process.env.GITHUB_OUTPUT, `verdict=${result.verdict}\nfabricated=${result.counts.fabricated}\nunsupported=${result.counts.unsupported}\nverified=${result.counts.verified}\nreport<<${delim}\n${md}\n${delim}\n`, 'the step outputs');
  }
  const c = result.counts;
  console.log(`${result.verdict.toUpperCase()}  ${result.label} — ${c.total} claims: ${c.verified} verified, ${c.unsupported} unsupported, ${c.fabricated} fabricated`);
}

function gitDiff(base) {
  try {
    return execSync(`git diff ${base}`, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  } catch (e) {
    throw new UsageError(`git diff ${base} failed: ${(e.stderr || e.message || '').toString().trim()}`);
  }
}

const HOOK_SNIPPET = (bin) => `{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Write|Edit|MultiEdit",
        "hooks": [ { "type": "command", "command": "${bin} hook" } ] }
    ]
  }
}`;

function init(dir = '.') {
  const path = `${dir.replace(/[\\/]+$/, '')}/${CONFIG_NAME}`;
  if (existsSync(path)) { console.log(`${path} already exists — leaving it alone.`); }
  else {
    const template = {
      $schema: 'https://raw.githubusercontent.com/AnonZ7/fact-gate/main/schema/fact-gate.schema.json',
      facts: {
        counts: {
          tests: { cmd: 'node --test --test-reporter=tap 2>&1', pattern: '# pass (\\d+)' },
        },
        tools: [],
      },
      include: ['.md', '.mdx', '.txt'],
      exclude: ['CHANGELOG.md', 'node_modules/'],
      config: { allow_metrics: [], forbidden_phrases: [] },
    };
    writeFileSync(path, JSON.stringify(template, null, 2) + '\n');
    console.log(`wrote ${path}`);
  }
  console.log(`
Install the CLI once so the hook is fast (it runs on every Write/Edit):

  npm install -g fact-gate          # or: npm install -g github:AnonZ7/fact-gate

Let the hook run the "cmd" measurements in this config (once; editing the file revokes it):

  fact-gate trust ${path}

Add the hook to .claude/settings.json (project) or ~/.claude/settings.json (global):

${HOOK_SNIPPET('fact-gate')}

Now every Write/Edit of a matching file is checked against the facts before it lands.
Try it:  echo "Ships with 1,200 tests." | fact-gate --facts ${path}`);
}

export async function main(argv = process.argv.slice(2)) {
  let args;
  try { args = parseArgs(argv); }
  catch (e) { console.error(`fact-gate: ${e.message}`); return 2; }
  if (args.help) { console.log(HELP); return 0; }
  if (args.version) { console.log(VERSION); return 0; }

  const sub = args._[0] && !args._[0].startsWith('-') ? args._[0] : 'check';
  if (sub === 'hook') return hookMain();
  if (sub === 'init') { init(args._[1]); return 0; }
  if (sub === 'pre-commit' || sub === 'precommit') return precommitMain({ strict: Boolean(args.strict), quiet: Boolean(args.quiet), paint: paint(useColor(args)) });
  if (sub === 'trust') {
    const target = args._[1] || CONFIG_NAME;
    try {
      const t = trust(target);
      console.log(`trusted ${t.path}`);
      for (const c of t.commands) console.log(`  will run: ${c}`);
      if (!t.commands.length) console.log('  (no command measurements in it — nothing needed trust)');
      console.log(`recorded in ${t.file}; editing the config revokes it.`);
      return 0;
    } catch (e) { console.error(`fact-gate: cannot trust "${target}": ${e.message}`); return 2; }
  }

  const color = useColor(args);
  const c = paint(color);
  try {
    if (sub === 'measure') {
      if (!args.facts) throw new UsageError('measure needs --facts <file>');
      const rawFacts = readJsonOrDie(args.facts, 'facts');
      let facts, measurements;
      if (isProjectConfig(rawFacts)) { const l = loadConfig(args.facts); facts = l.options.facts; measurements = l.measurements; }
      else ({ facts, measurements } = resolveFacts(rawFacts));
      const numeric = (v) => (typeof v === 'string' && /^\d+(?:\.\d+)?$/.test(v)) ? Number(v) : v;
      const plain = JSON.parse(JSON.stringify(facts, (k, v) => Array.isArray(v) ? v : numeric(v)));
      if (args.format === 'json' || args.json || !process.stdout.isTTY) console.log(JSON.stringify(plain, null, 2));
      else {
        for (const m of measurements) console.log(`${c(36, m.key)} = ${c(1, Array.isArray(m.value) ? m.value.join(', ') : m.value)}   ${c(2, m.via)}`);
        if (!measurements.length) console.log('no measurements in this facts file');
      }
      return 0;
    }
    if (sub !== 'check') throw new UsageError(`unknown command "${sub}"`);

    if (!args.source && !args.facts && !args.diff && !args.git) throw new UsageError('need at least one source of truth: --source, --facts, --diff or --git');

    let target;
    if (args['target-env']) {
      target = process.env[args['target-env']];
      if (target == null) throw new UsageError(`environment variable ${args['target-env']} is not set`);
    } else if (!args.target || args.target === '-') target = await readStdin();
    else target = readOrDie(args.target, 'target');

    const options = { label: args.label || args.target || (args['target-env'] ? `$${args['target-env']}` : 'stdin') };
    let measurements = [];
    if (args.source) options.source = readOrDie(args.source, 'source');
    if (args.facts && isProjectConfig(readJsonOrDie(args.facts, 'facts'))) {
      // A project config (.fact-gate.json): facts, source, nouns, config and
      // ignoreCode all come from it; explicit flags below still override.
      const loaded = loadConfig(args.facts);
      Object.assign(options, loaded.options);
      measurements = loaded.measurements;
    } else if (args.facts) {
      const raw = readJsonOrDie(args.facts, 'facts');
      if (args['no-measure']) {
        const specs = collectMeasurementKeys(raw);
        if (specs.length) throw new UsageError(`--no-measure but --facts has unresolved measurement specs: ${specs.join(', ')} (run "fact-gate measure" first)`);
        options.facts = raw;
      } else { const r = resolveFacts(raw); options.facts = r.facts; measurements = r.measurements; }
    }
    if (args.diff) {
      const text = args.diff === '-' ? await readStdin() : readOrDie(args.diff, 'diff');
      options.facts = mergeFacts(factsFromDiff(text), options.facts);
    }
    if (args.git) options.facts = mergeFacts(factsFromDiff(gitDiff(args.git)), options.facts);
    if (args.jd) options.jd = readOrDie(args.jd, 'jd');
    if (args.config) options.config = readJsonOrDie(args.config, 'config');
    if (args.nouns) options.nouns = String(args.nouns).split(',').map(s => s.trim()).filter(Boolean);
    if (args['ignore-code']) options.ignoreCode = true;

    const result = verifyFacts(target, options);
    const format = args.json ? 'json' : (args.format || 'text');

    if (format === 'json') console.log(JSON.stringify({ ...result, measurements }, null, 2));
    else if (format === 'markdown') process.stdout.write(formatMarkdown(result, { measurements }));
    else if (format === 'github') emitGithub(result, { measurements });
    else if (format === 'text') {
      if (!(args.quiet && result.verdict === 'pass')) {
        const n = result.counts;
        const tag = { pass: c(32, 'PASS '), warn: c(33, 'WARN '), block: c(31, 'BLOCK') }[result.verdict];
        console.log(`${tag}  ${options.label} — ${n.total} claims: ${c(32, n.verified + ' verified')}, ${c(33, n.unsupported + ' unsupported')}, ${c(31, n.fabricated + ' fabricated')}`);
        if (result.verdict !== 'pass' || result.allowlist.unused.length) {
          console.log('  ' + formatReport(result).replace(/\[CRITICAL\]/g, c(31, '[CRITICAL]')).replace(/\[WARNING\]/g, c(33, '[WARNING]')).replace(/\[NOTE\]/g, c(2, '[NOTE]')));
        }
        if (measurements.length) console.log(c(2, `  measured: ${measurements.map(m => `${m.key}=${Array.isArray(m.value) ? m.value.length + ' items' : m.value}`).join('  ')}`));
      }
    } else throw new UsageError(`unknown --format "${format}"`);

    if (result.verdict === 'block') return 1;
    if (result.verdict === 'warn' && args.strict) return 1;
    return 0;
  } catch (e) {
    if (e instanceof UsageError) { console.error(`fact-gate: ${e.message}`); return 2; }
    console.error(`fact-gate: ${e.message}`);
    return 2;
  }
}

const invokedDirectly = process.argv[1] && /(?:^|[\\/])(?:cli\.mjs|fact-gate)$/.test(process.argv[1]);
if (invokedDirectly) main().then(code => process.exit(code));
