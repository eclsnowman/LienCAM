// The WO owns this directory, not tools/*.d.mts. Match only this tool's import.
declare module '*/i18n-freshness.mjs' {
  export interface Content { text: string; fingerprint: string }
  export interface Snapshot {
    schemaVersion: number
    source: Record<string, Content>
    translations: Record<string, Record<string, Content>>
    files: string[]
  }
  export interface Review {
    status: string
    reviewer?: string
    evidence?: string
    // Exact reviewed contents, independent of the mutable association below.
    // Optional only for legacy/unreviewed history; both required to apply.
    sourceFingerprint?: string
    translationFingerprint?: string
  }
  export interface Association {
    sourceFingerprint: string
    translationFingerprint: string
    provenance?: { kind: string; evidence: string }
    review?: Review
  }
  export interface Metadata {
    schemaVersion: number
    entries: Record<string, Record<string, Association>>
    protectedTokens?: Record<string, string[]>
  }
  export type State = 'current' | 'missing' | 'source-changed' | 'translation-unverified' | 'obsolete'
  export interface Issue { kind: string; [key: string]: unknown }
  export interface Row {
    language: string
    key: string
    state: State
    reasons: string[]
    issues: Issue[]
    sourceFingerprint: string | null
    translationFingerprint: string | null
    sourceMatch: boolean
    translationMatch: boolean
    provenance: Association['provenance'] | null
    review: Review
    reviewApplies: boolean
  }
  export interface FreshnessReport {
    schemaVersion: number
    policy: string
    languages: string[]
    summary: Record<string, Record<State, number>>
    deltas: Array<{ key: string; change: 'added' | 'removed' | 'changed' }>
    affected: Array<Pick<Row, 'language' | 'key' | 'state'>>
    rows: Row[]
  }
  export function fingerprint(value: unknown): string
  export function discoverCatalogs(root?: string): Array<{ language: string; area: string; file: string }>
  export function flatten(tree: unknown, prefix?: string, result?: Record<string, string>): Record<string, string>
  export function helpContexts(topics: Array<{ id: string; sections: unknown[] }>): Record<string, unknown>
  export function makeSnapshot(english: Record<string, string>, locales: Record<string, Record<string, string>>,
    contexts?: Record<string, unknown>, files?: Iterable<string>): Snapshot
  export function loadSnapshot(root?: string): Promise<Snapshot>
  export function emptyMetadata(): Metadata
  export function bootstrap(snapshot: Snapshot, metadata?: Metadata, options?: { keys?: string[]; evidence?: string }): Metadata
  export function structuralIssues(english: string, translation: string, protectedTokens?: string[]): Issue[]
  export function reportFreshness(snapshot: Snapshot, metadata?: Metadata, options?: { previous?: Snapshot }): FreshnessReport
  export function renderReport(report: FreshnessReport): string
  // WO-2943: the generated browser fallback list (src/i18n/freshness/stale.json).
  export interface RuntimeFallback {
    schemaVersion: number
    generatedBy: string
    policy: string
    fallback: Record<string, string[]>
  }
  export const RUNTIME_FILE: string
  export function runtimeFallback(report: FreshnessReport): RuntimeFallback
  export function renderRuntime(runtime: RuntimeFallback): string
  export function formatMetadata(metadata: Metadata): string
  export function associate(snapshot: Snapshot, metadata?: Metadata, options?: { language?: string; keys?: string[]; evidence?: string }): Metadata
}
