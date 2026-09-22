// Trust for command measurements.
//
// A `.fact-gate.json` can say `{"cmd": "node --test"}`. In the CLI and in
// CI that is the same trust you already extend to `npm test`: you chose to
// run this repository's code. The Claude Code hook is different — it fires
// on every file the agent writes, in whatever repository was just cloned,
// and a config file in that clone must not be able to run commands on your
// machine just because an agent wrote a README.
//
// So in hook mode a `cmd` measurement runs only when the config file has
// been explicitly trusted: `fact-gate trust` records the file's path and a
// hash of its contents in ~/.fact-gate/trusted.json. Change the file and it
// is untrusted again. Until then the hook still runs `file` and `json`
// measurements and literal facts, and tells the agent why the command was
// skipped.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';

export function trustFile() {
  return process.env.FACT_GATE_TRUST_FILE || join(homedir(), '.fact-gate', 'trusted.json');
}

function readTrust() {
  try { return JSON.parse(readFileSync(trustFile(), 'utf8')); } catch { return {}; }
}

export function hashOf(content) {
  return createHash('sha256').update(String(content)).digest('hex');
}

/** Is this config file (at this exact content) trusted to run `cmd` measurements? */
export function isTrusted(cfgPath, content = readFileSync(cfgPath, 'utf8')) {
  if (process.env.FACT_GATE_ALLOW_CMD === '1') return true;
  const key = resolvePath(cfgPath).replace(/\\/g, '/');
  return readTrust()[key] === hashOf(content);
}

/** Record trust for a config file's current contents. */
export function trust(cfgPath) {
  const abs = resolvePath(cfgPath);
  const content = readFileSync(abs, 'utf8');
  const cmds = [];
  const walk = (v, k) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if (typeof v.cmd === 'string') cmds.push(`${k}: ${v.cmd}`);
      for (const [ck, cv] of Object.entries(v)) walk(cv, k ? `${k}.${ck}` : ck);
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${k}[${i}]`));
  };
  walk(JSON.parse(content), '');
  const file = trustFile();
  const all = readTrust();
  all[abs.replace(/\\/g, '/')] = hashOf(content);
  if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(all, null, 2) + '\n');
  return { file, path: abs, commands: cmds };
}
