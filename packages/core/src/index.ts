export type TaskType =
	| "implement"
	| "implement_reviewed"
	| "plan"
	| "pr_review"
	| "awaiting_approval"
	| "idle"
	| "plan_failed"
	| "implement_conflict"
	| "validation_failed"
	| "error";

export type OutcomeType = "success" | "error" | "timeout" | "budget_exceeded";

export interface LogRecord {
	run_id: string;
	timestamp: string;
	repo: string;
	task: TaskType;
	issue: number | null;
	pr: number | null;
	duration_ms: number;
	tokens: { input: number; output: number; total: number };
	outcome: OutcomeType;
	error: string | null;
	conflict_files: string[] | null;
}

export interface ReviewThread {
	id: string;
	isResolved: boolean;
	path: string;
	diffHunk: string;
	line: number | null;
	comments: ReviewComment[];
}

export interface ReviewComment {
	databaseId: number;
	author: string;
	body: string;
}

export interface ReviewSummary {
	databaseId: number;
	author: string;
	body: string;
}

export interface PRSummary {
	number: number;
	title: string;
	headRef: string;
	updatedAt: string;
	threads: ReviewThread[];
	reviews: ReviewSummary[];
}

export interface IssueSummary {
	number: number;
	title: string;
	body: string;
	author: string;
	createdAt: string;
	labels: string[];
	comments: IssueComment[];
}

export interface IssueComment {
	databaseId: number;
	author: string;
	body: string;
	createdAt: string;
}
