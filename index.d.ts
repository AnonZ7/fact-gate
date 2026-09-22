export type ClaimKind = 'count' | 'percentage' | 'amount' | 'multiplier' | 'year' | 'spelled_years' | 'employer' | 'title' | 'tool';
export type ClaimStatus = 'verified' | 'unsupported' | 'fabricated';
export type Verdict = 'pass' | 'warn' | 'block';

export interface NumericClaim {
  kind: 'count' | 'percentage' | 'amount' | 'multiplier' | 'year' | 'spelled_years';
  noun: string | null;
  number: string | number;
  claim: string;
  modifiers?: string[];
  isLowerBound?: boolean;
  /** "about N", "roughly N", "~N" — judged with `approxTolerance`. */
  approximate?: boolean;
  range?: boolean;
  derivedFrom?: 'breakdown' | 'subcount' | 'noun-first' | 'facts' | 'spelled';
}
export interface FactClaim { kind: 'employer' | 'title' | 'tool'; value: string; }
export type Claim = (NumericClaim | FactClaim) & { status: ClaimStatus; reason?: string };

/** A value derived at check time instead of typed. Exactly one of cmd | file | json. */
export interface Measurement {
  /** Shell command; stdout+stderr is searched with `pattern`. */
  cmd?: string;
  /** Text file searched with `pattern`. */
  file?: string;
  /** JSON file; `path` selects a value (dotted; `.length` and `.keys` supported). */
  json?: string;
  path?: string;
  /** Regular expression; the first capture group (or `group`) is the value. */
  pattern?: string;
  group?: number;
  flags?: string;
}
export type Measured<T> = T | Measurement;

export interface Facts {
  /** "<qualifiers> <noun>" -> number; a trailing "+" marks a lower bound. */
  counts?: Record<string, Measured<number | string>>;
  years?: Array<Measured<number | string>>;
  percentages?: Array<Measured<string>>;
  amounts?: Array<Measured<string>>;
  multipliers?: Array<Measured<string>>;
  employers?: Array<Measured<string>>;
  titles?: Array<Measured<string>>;
  tools?: Array<Measured<string>>;
  /** "YYYY-MM" — earliest role start, for tenure claims. */
  experience_start?: Measured<string>;
  /** File paths (populated by factsFromDiff). */
  files?: string[];
  [extra: string]: unknown;
}

export interface GateConfig {
  allow_metrics?: string[];
  allow_facts?: string[];
  forbidden_phrases?: string[];
  warn_phrases?: string[];
}

export interface VerifyOptions {
  /** Prose source of truth. */
  source?: string;
  /** @deprecated alias of `source` */
  sourceText?: string;
  /** Structured facts (plain values — resolve measurements first with `resolveFacts`). */
  facts?: Facts | null;
  /** A unified diff or `git diff --numstat` output; its counts become facts (see factsFromDiff). */
  diff?: string;
  /** Reference text the model was shown; figures echoed from it are downgraded, not blocked. */
  jd?: string;
  /** @deprecated alias of `jd` */
  jdText?: string;
  config?: GateConfig;
  nouns?: string[];
  synonyms?: Record<string, string>;
  /** Minimum ratio for an "N+" floor to be honest (default 0.5). */
  floorRatio?: number;
  /** Relative tolerance for "about N" claims (default 0.1). */
  approxTolerance?: number;
  label?: string;
  /** Clock for tenure checks (ms since epoch). */
  now?: number;
  /** Drop fenced and inline code from the target before extraction (README examples are not claims). */
  ignoreCode?: boolean;
}

export interface VerifyResult {
  label: string;
  verdict: Verdict;
  claims: Claim[];
  verified: Claim[];
  unsupported: Claim[];
  fabricated: Claim[];
  forbidden: string[];
  warnings: string[];
  allowlist: { used: string[]; unused: string[] };
  counts: { total: number; verified: number; unsupported: number; fabricated: number };
}

export const VERSION: string;
export function verifyFacts(target: string, options: VerifyOptions): VerifyResult;
export function assertFacts(target: string, options: VerifyOptions): VerifyResult;
export function formatReport(result: VerifyResult): string;
/** @deprecated alias of formatReport */
export function formatFactFailures(result: VerifyResult): string;
export function mergeFacts(a: Facts | null | undefined, b: Facts | null | undefined): Facts | null | undefined;

// ---------------------------------------------------------------- diff
export interface DiffFile {
  path: string;
  oldPath: string | null;
  status: 'added' | 'deleted' | 'modified' | 'renamed';
  additions: number;
  deletions: number;
  binary: boolean;
  isTest: boolean;
  testsAdded: number;
}
export interface ParsedDiff {
  format: 'unified' | 'numstat' | 'empty';
  files: DiffFile[];
  dependenciesAdded: string[];
  dependenciesRemoved: string[];
}
export function parseDiff(text: string): ParsedDiff;
export function factsFromDiff(text: string, options?: { commits?: number }): Facts;

// ---------------------------------------------------------------- measured facts
export interface MeasureContext {
  cwd?: string; timeout?: number; env?: Record<string, string>; exec?: (cmd: string) => string;
  /** false: `cmd` specs are dropped and listed in `skipped` instead of run. */
  allowCmd?: boolean;
}
export interface MeasurementRecord { key: string; value: string | string[]; via: string }
export class CommandNotAllowed extends Error { cmd: string }
export function isMeasurement(value: unknown): value is Measurement;
export function measure(spec: Measurement, ctx?: MeasureContext): { value: string | string[]; via: string };
export function resolveFacts(facts: Facts, ctx?: MeasureContext): { facts: Facts; measurements: MeasurementRecord[]; skipped: Array<{ key: string; cmd: string }> };

// ---------------------------------------------------------------- trust (hook mode)
/** Path of the trust store (~/.fact-gate/trusted.json, or FACT_GATE_TRUST_FILE). */
export function trustFile(): string;
/** Is this config file, at its current contents, allowed to run `cmd` measurements in hook mode? */
export function isTrusted(configPath: string, content?: string): boolean;
/** Record trust for a config file's current contents. */
export function trust(configPath: string): { file: string; path: string; commands: string[] };

// ---------------------------------------------------------------- Claude Code hook
export const CONFIG_NAME: '.fact-gate.json';
export interface HookPayload { hook_event_name?: string; tool_name?: string; tool_input?: Record<string, unknown>; cwd?: string }
export interface HookOutcome { decision: 'allow' | 'deny' | 'skip'; output: object | null; result?: VerifyResult; reason?: string }
export function runHook(payload: HookPayload, options?: { cwd?: string; configPath?: string }): HookOutcome;
export interface ProjectConfig {
  facts?: string | Facts; source?: string; jd?: string; include?: string[]; exclude?: string[];
  nouns?: string[]; synonyms?: Record<string, string>; ignoreCode?: boolean; warnUnsupported?: boolean; config?: GateConfig;
}
export function isProjectConfig(value: unknown): value is ProjectConfig;
export function loadConfig(configPath: string, options?: { allowCmd?: boolean }): { cfg: ProjectConfig; options: VerifyOptions; measurements: MeasurementRecord[]; skipped: Array<{ key: string; cmd: string }>; dir: string };
export function findConfig(dir: string, name?: string): string | null;
export function projectedContent(toolName: string, input: Record<string, unknown>, readExisting: () => string): string | null;

// ---------------------------------------------------------------- extraction / comparison
export interface Extractor {
  numericClaims(text: string): NumericClaim[];
  factClaims(text: string): FactClaim[];
  nouns: string[];
  canon(noun: string): string;
}
export function createExtractor(options?: { nouns?: string[]; synonyms?: Record<string, string>; modifierWindow?: number }): Extractor;
export function numericClaims(text: string): NumericClaim[];
export function factClaims(text: string): FactClaim[];
export const DEFAULT_NOUNS: string[];
export const DEFAULT_SYNONYMS: Record<string, string>;
export function stripMarkup(text: string): string;
export function normalizeNumber(token: string): string;
export function normalizeClaim(claim: string): string;

export interface SourceIndex {
  exact: Set<string>;
  byNoun: Map<string, Array<{ number: string; modifiers: Set<string>; isLowerBound?: boolean; origin: string }>>;
  plain: string;
  allow: Map<string, Set<string>>;
  facts: Facts | null;
}
export function indexSource(options: { sourceText?: string; facts?: Facts | null; allowMetrics?: string[]; extractor?: Extractor }): SourceIndex;
export function claimsFromFacts(facts: Facts, extractor: Extractor): NumericClaim[];
export function findVerification(source: SourceIndex, claim: NumericClaim): object | null;
export function contradicts(source: SourceIndex, claim: NumericClaim): string[] | null;
export function lowerBoundCheck(source: SourceIndex, claim: NumericClaim, options?: { floorRatio?: number }): { result: 'ok' | 'exceeds' | 'too-low' | 'none'; actual?: string; floor?: number };
export function earliestExperienceStart(sourceText?: string, facts?: Facts | null): Date | null;
export function experienceYears(sourceText?: string, facts?: Facts | null, now?: number): number | null;

export default verifyFacts;
