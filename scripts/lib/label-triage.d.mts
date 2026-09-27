export interface TriageableIssue {
	number: number;
	title: string;
	html_url?: string;
	pull_request?: unknown;
	labels?: Array<string | { name?: string }>;
}

export interface UntriagedEntry {
	issue: TriageableIssue;
	missing: Array<"type" | "priority">;
}

export const TYPE_LABELS: string[];
export const MAX_PAGES: number;
export const PAGE_SIZE: number;

export function deriveTypeLabels(manifestText?: string): string[];

export function isTrackingIssueTitle(title: unknown): boolean;

export function hasTypeLabel(
	labels: TriageableIssue["labels"],
	typeLabels?: string[],
): boolean;

export function hasPriorityLabel(labels: TriageableIssue["labels"]): boolean;

export function isUntriagedIssue(
	issue: TriageableIssue,
	typeLabels?: string[],
): boolean;

export function findUntriagedIssues(
	issues: TriageableIssue[],
	typeLabels?: string[],
): UntriagedEntry[];

export function formatUntriagedReport(untriaged: UntriagedEntry[]): string;

export function fetchOpenIssues(
	repository: string,
	token: string,
	fetchImpl?: (
		url: string,
		init?: RequestInit,
	) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>,
): Promise<TriageableIssue[]>;
