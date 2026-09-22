// fact-gate — public entry point.
//
// Everything in core.mjs is environment-free (browser-safe). The rest needs
// Node: measured facts run commands and read files, the hook reads the
// repository, trust writes to the home directory.

export * from './core.mjs';
export { default } from './core.mjs';
export { resolveFacts, measure, isMeasurement, CommandNotAllowed } from './facts.mjs';
export { runHook, findConfig, projectedContent, loadConfig, isProjectConfig, CONFIG_NAME } from './hook.mjs';
export { trust, isTrusted, trustFile } from './trust.mjs';
export { checkStaged, stagedPaths, stagedContent } from './precommit.mjs';
