import type { EnvConfig, RepoConfig } from "@steward/config";
import type { IssueSummary } from "@steward/core";
import { GitHubClient } from "@steward/gh-client";
import { Implementer } from "./implementer.js";
import type { Logger } from "./logger.js";
import { Planner } from "./planner.js";
import { PRFixer } from "./pr-fixer.js";

export class Agent {
	private readonly gh: GitHubClient;
	private readonly env: EnvConfig;
	private readonly config: RepoConfig;
	private readonly logger: Logger;

	private readonly planner: Planner;
	private readonly implementer: Implementer;

	constructor(env: EnvConfig, config: RepoConfig, logger: Logger) {
		this.env = env;
		this.config = config;
		this.logger = logger;
		this.gh = new GitHubClient(env.githubToken, env.githubRepo);
		this.planner = new Planner(env, config, logger, this.gh);
		this.implementer = new Implementer(env, config, logger, this.gh);
	}

	async run(): Promise<void> {
		// ── Rate limit check ──────────────────────────────────────────────────────
		const rateLimit = await this.gh.getRateLimit();
		if (rateLimit.remaining < this.config.rateLimitThreshold) {
			const resetsAt = rateLimit.resetAt.toISOString();
			this.logger.write("idle", "success", {
				error: `Rate limit low: ${rateLimit.remaining} remaining (threshold: ${this.config.rateLimitThreshold}). Resets at ${resetsAt}`,
			});
			return;
		}

		// ── PR triage ─────────────────────────────────────────────────────────────
		const prs = await this.gh.getOpenPRsWithUnresolvedThreads();
		const qualifyingPRs = prs.filter(
			(pr) =>
				// Only address PRs that steward opened
				pr.headRef.startsWith("agent/") &&
				(pr.threads.some((t) =>
					this.threadQualifies(t.comments.map((c) => c.author)),
				) ||
					pr.reviews.some((r) => this.reviewQualifies(r.author))),
		);

		if (qualifyingPRs.length > 0) {
			const pr = qualifyingPRs[0]; // highest priority (oldest-updated, lowest number)
			const fixer = new PRFixer(this.env, this.config, this.logger, this.gh);
			const result = await fixer.fix(pr);
			switch (result.status) {
				case "success":
					this.logger.write("pr_review", "success", { pr: pr.number });
					break;
				case "budget_exceeded":
					this.logger.write("pr_review", "budget_exceeded", { pr: pr.number });
					break;
				case "error":
					this.logger.write("pr_review", "error", {
						pr: pr.number,
						error: result.error,
					});
					break;
			}
			return;
		}

		// ── Issue triage ──────────────────────────────────────────────────────────
		const allIssues = await this.gh.getOpenIssues(this.config.priorityLabels);
		const candidates = await this.filterIssues(allIssues);

		if (candidates.length === 0) {
			this.logger.write("idle", "success");
			return;
		}

		let allAwaitingApproval = true;

		for (const issue of candidates) {
			const planComment = this.findPlanComment(issue);

			if (!planComment) {
				const result = await this.planner.generateAndPost(issue);
				if (result === "failed") {
					this.logger.write("plan_failed", "error", { issue: issue.number });
				} else {
					this.logger.write("plan", "success", { issue: issue.number });
				}
				allAwaitingApproval = false;
				return;
			}

			const approved = this.isPlanApproved(issue, planComment);
			if (!approved) {
				// Plan posted but not yet approved — skip this issue
				continue;
			}

			// Plan approved — implement
			allAwaitingApproval = false;
			const planBody = extractPlanBody(planComment.body);
			const result = await this.implementer.run(issue, planBody);

			switch (result.status) {
				case "success":
					this.logger.write("implement", "success", {
						issue: issue.number,
						pr: result.prNumber,
					});
					break;
				case "reviewed":
					this.logger.write("implement_reviewed", "success", {
						issue: issue.number,
						pr: result.prNumber,
					});
					break;
				case "conflict":
					await this.recordFailure(issue);
					this.logger.write("implement_conflict", "error", {
						issue: issue.number,
						conflict_files: result.conflictFiles,
					});
					break;
				case "budget_exceeded":
					this.logger.write("implement", "budget_exceeded", {
						issue: issue.number,
					});
					break;
				case "error":
					await this.recordFailure(issue);
					this.logger.write("implement", "error", {
						issue: issue.number,
						error: result.error,
					});
					break;
			}
			return;
		}

		if (allAwaitingApproval) {
			this.logger.write("awaiting_approval", "success");
		}
	}

	// ── Helpers ─────────────────────────────────────────────────────────────────

	/**
	 * Increments the agent:failures:N label on an issue.
	 * At MAX_ISSUE_FAILURES consecutive failures, applies agent:blocked instead.
	 */
	private async recordFailure(issue: IssueSummary): Promise<void> {
		const { issueFailures: max } = this.config.limits;
		const failureLabels = issue.labels.filter((l) =>
			/^agent:failures:\d+$/.test(l),
		);
		const current = failureLabels.reduce((n, l) => {
			const m = l.match(/\d+$/);
			return m ? Math.max(n, parseInt(m[0], 10)) : n;
		}, 0);

		// Remove old failure label
		for (const label of failureLabels) {
			await this.gh.removeLabel(issue.number, label);
		}

		const next = current + 1;
		if (next >= max) {
			await this.gh.addLabel(issue.number, "agent:blocked");
		} else {
			await this.gh.addLabel(issue.number, `agent:failures:${next}`);
		}
	}

	/**
	 * Returns true if a thread has at least one comment from a qualifying user
	 * (allowlist member, or any non-skiplist user when allowlist is empty).
	 */
	private threadQualifies(authors: string[]): boolean {
		const { allowlist, skiplist } = this.config;
		const nonBot = authors.filter((a) => !skiplist.includes(a));
		if (nonBot.length === 0) return false;
		if (allowlist.length === 0) return true;
		return nonBot.some((a) => allowlist.includes(a));
	}

	/**
	 * Returns true if a top-level review author is a qualifying user
	 * (allowlist member, or any non-skiplist user when allowlist is empty).
	 */
	private reviewQualifies(author: string): boolean {
		const { allowlist, skiplist } = this.config;
		if (skiplist.includes(author)) return false;
		if (allowlist.length === 0) return true;
		return allowlist.includes(author);
	}

	/**
	 * Filter issues according to allowlist rules, blocked label, and existing open PRs.
	 */
	private async filterIssues(issues: IssueSummary[]): Promise<IssueSummary[]> {
		const results: IssueSummary[] = [];

		for (const issue of issues) {
			// Skip issues labeled agent:blocked
			if (issue.labels.includes("agent:blocked")) continue;

			// Skip if no required label is present
			if (this.config.requiredLabels.length > 0) {
				const hasRequired = issue.labels.some((l) =>
					this.config.requiredLabels.includes(l),
				);
				if (!hasRequired) continue;
			}

			// Skip if an open agent PR already exists for this issue
			const hasOpenPR = await this.gh.hasOpenAgentPR(issue.number);
			if (hasOpenPR) continue;

			// Apply allowlist filter
			if (
				this.config.requireIssueAllowlist &&
				this.config.allowlist.length > 0
			) {
				const authorAllowlisted = this.config.allowlist.includes(issue.author);
				const hasConsiderComment = issue.comments.some(
					(c) =>
						this.config.allowlist.includes(c.author) &&
						c.body.includes("agent: consider"),
				);
				if (!authorAllowlisted && !hasConsiderComment) continue;
			}

			results.push(issue);
		}

		return results;
	}

	/**
	 * Finds the agent-plan comment on an issue (posted by the bot).
	 * Returns the comment body if found, null otherwise.
	 */
	private findPlanComment(
		issue: IssueSummary,
	): { id: number; body: string; hash: string } | null {
		const marker = "<!-- agent-plan:hash=";
		for (const comment of issue.comments) {
			if (comment.author !== this.env.githubBotUsername) continue;
			const idx = comment.body.indexOf(marker);
			if (idx === -1) continue;
			const start = idx + marker.length;
			const end = comment.body.indexOf(" -->", start);
			if (end === -1) continue;
			const hash = comment.body.slice(start, end);
			return { id: comment.databaseId, body: comment.body, hash };
		}
		return null;
	}

	/**
	 * Returns true if any allowlist-qualifying user has posted an approval comment
	 * that references the current plan's hash.
	 */
	private isPlanApproved(
		issue: IssueSummary,
		planComment: { id: number; hash: string },
	): boolean {
		const { allowlist, skiplist, requireIssueAllowlist } = this.config;

		for (const comment of issue.comments) {
			// Skip the plan comment itself — its footer contains the literal "agent: approved {hash}"
			// as copy-paste instructions, which would otherwise trigger a false match.
			// Exclude by ID rather than author so this works correctly with PATs too.
			if (comment.databaseId === planComment.id) continue;
			if (skiplist.includes(comment.author)) continue;
			if (
				requireIssueAllowlist &&
				allowlist.length > 0 &&
				!allowlist.includes(comment.author)
			)
				continue;
			if (
				comment.body.includes("agent: approved") &&
				comment.body.includes(planComment.hash)
			) {
				return true;
			}
		}
		return false;
	}
}

/**
 * Strips the header line and footer from a plan comment, returning just the plan body.
 * Comment format:
 *   ## Implementation Plan <!-- agent-plan:hash=... -->
 *   \n
 *   {plan body}
 *   \n
 *   ---
 *   *To approve...*
 */
function extractPlanBody(commentBody: string): string {
	const lines = commentBody.split("\n");
	// Drop the header (first line with the ## and HTML comment)
	const start = lines.findIndex((l) => l.startsWith("## Implementation Plan"));
	const bodyLines = start >= 0 ? lines.slice(start + 1) : lines;
	// Drop the footer (--- separator onward)
	const end = bodyLines.findIndex((l) => l.trim() === "---");
	const trimmed = end >= 0 ? bodyLines.slice(0, end) : bodyLines;
	return trimmed.join("\n").trim();
}
