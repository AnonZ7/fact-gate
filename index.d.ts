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
  range?: boolean;
  derivedFrom?: 'breakdown' | 'subcount' | 'noun-first' | 'facts';
}
export interface FactClaim { kind: 'employer' | 'title' | 'tool'; value: string; }
export type Claim = (NumericClaim | FactClaim) & { status: ClaimStatus; reason?: string };

export interface Facts {
  /** "<qualifiers> <noun>" -> number; a trailing "+" marks a lower bound. */
  counts?: Record<string, number | string>;
  years?: Array<number | string>;
  percentages?: string[];
  amounts?: string[];
  multipliers?: string[];
  employers?: string[];
  titles?: string[];
  tools?: string[];
  /** "YYYY-MM" — earliest role start, for tenure claims. */
  experience_start?: string;
}

export interface GateConfig {
  allow_metrics?: string[];
  allow_facts?: string[];
  forbidden_phrases?: string[];
  warn_phrases?: string[];
}

export interface VerifyOptions {
  source?: string;
  sourceText?: string;
  facts?: Facts | null;
  jd?: string;
  jdText?: string;
  config?: GateConfig;
  nouns?: string[];
  synonyms?: Record<string, string>;
  floorRatio?: number;
  label?: string;
  now?: number;
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
export const DEFAULT_NOUNS: string[];
export const DEFAULT_SYNONYMS: Record<string, string>;

export function verifyFacts(target: string, options: VerifyOptions): VerifyResult;
export function assertFacts(target: string, options: VerifyOptions): VerifyResult;
export function formatReport(result: VerifyResult): string;
export const formatFactFailures: typeof formatReport;

export function stripMarkup(text: unknown): string;
export function normalizeNumber(token: string): string;
export function normalizeClaim(claim: string): string;

export interface Extractor {
  numericClaims(text: string): NumericClaim[];
  factClaims(text: string): FactClaim[];
  nouns: string[];
  canon(noun: string): string;
}
export function createExtractor(options?: { nouns?: string[]; synonyms?: Record<string, string>; modifierWindow?: number }): Extractor;
export function numericClaims(text: string): NumericClaim[];
export function factClaims(text: string): FactClaim[];

export function claimsFromFacts(facts: Facts | null | undefined, extractor: Extractor): NumericClaim[];
export function indexSource(options: { sourceText?: string; facts?: Facts | null; allowMetrics?: string[]; extractor?: Extractor }): unknown;
export function earliestExperienceStart(sourceText?: string, facts?: Facts | null): Date | null;
export function experienceYears(sourceText?: string, facts?: Facts | null, now?: number): number | null;

export default verifyFacts;
