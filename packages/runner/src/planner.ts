import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import type { EnvConfig, RepoConfig } from "@steward/config";
import type { GitHubClient } from "@steward/gh-client";
import type { Logger } from "./logger.js";
import type { IssueSummary } from "@steward/core";

const PLAN_MAX_LINES = 200;
const PLAN_MAX_CHARS = 8000;

export class Planner {
	private readonly ai: Anthropic;

	constructor(
		private readonly env: EnvConfig,
		private readonly config: RepoConfig,
		private readonly logger: Logger,
		private readonly gh: GitHubClient,
	) {
		this.ai = new Anthropic({ apiKey: env.anthropicApiKey });
	}

	async generateAndPost(issue: IssueSummary): Promise<"posted" | "failed"> {
		const contribAgents = this.readRepoFile("CONTRIB-agents.md");
		const context = this.readRepoFile("CONTEXT.md");
		const systemPrompt = this.buildSystemPrompt(contribAgents, context);

		let plan: string | null = null;

		for (
			let attempt = 0;
			attempt <= this.config.limits.planRetries;
			attempt++
		) {
			const userPrompt =
				attempt === 0
					? this.buildUserPrompt(issue, false)
					: this.buildUserPrompt(issue, true);

			const response = await this.ai.messages.create({
				model: this.config.models.plan,
				max_tokens: 2048,
				system: systemPrompt,
				messages: [{ role: "user", content: userPrompt }],
			});

			this.logger.addTokens(
				response.usage.input_tokens,
				response.usage.output_tokens,
			);

			const text =
				response.content.find((b) => b.type === "text")?.text?.trim() ?? "";
			const lineCount = text.split("\n").length;

			if (lineCount <= PLAN_MAX_LINES && text.length <= PLAN_MAX_CHARS) {
				plan = text;
				break;
			}

			process.stderr.write(
				`[steward] Plan attempt ${attempt + 1} oversized (${lineCount} lines, ${text.length} chars) — retrying with stricter prompt\n`,
			);
		}

		if (!plan) return "failed";

		const hash = createHash("sha256").update(plan).digest("hex");
		const body = this.formatComment(plan, hash);

		process.stderr.write(
			`[steward] Plan for issue #${issue.number}:\n${body}\n`,
		);

		if (this.env.dryRun) {
			process.stderr.write(`[steward] DRY RUN — skipping GitHub comment\n`);
		} else {
			await this.gh.postIssueComment(issue.number, body);
		}

		return "posted";
	}

	// ── Private ─────────────────────────────────────────────────────────────────

	private readRepoFile(filename: string): string | null {
		const path = join(this.env.workDir, filename);
		if (!existsSync(path)) return null;
		try {
			return readFileSync(path, "utf-8").trim();
		} catch {
			return null;
		}
	}

	private buildSystemPrompt(
		contribAgents: string | null,
		context: string | null,
	): string {
		const parts: string[] = [
			"You are steward, an automated software agent. Produce a concise implementation plan for a GitHub issue.",
			"",
			"## Rules",
			`- Maximum ${PLAN_MAX_LINES} lines and ${PLAN_MAX_CHARS} characters.`,
			"- Output only the plan — no preamble, no sign-off, no meta-commentary.",
			"- Ordered Markdown list of steps. Sub-bullets only when genuinely necessary.",
			"- Describe *what* to change, not *how* to implement every detail.",
			"- No code snippets unless a specific interface or signature is critical to convey.",
			"- Do not restate the issue title or body.",
		];

		if (context) {
			parts.push("", "## Project context", "", context);
		}

		if (contribAgents) {
			parts.push("", "## Agent contribution guidelines", "", contribAgents);
		}

		return parts.join("\n");
	}

	private buildUserPrompt(issue: IssueSummary, strict: boolean): string {
		const parts: string[] = [];

		if (strict) {
			parts.push(
				`Your previous plan was too long. Limit to ${PLAN_MAX_LINES} lines and ${PLAN_MAX_CHARS} characters. High-level steps only — no sub-bullets.\n`,
			);
		}

		parts.push(
			"Produce an implementation plan for this GitHub issue.",
			"",
			"<user-content>",
		);
		parts.push(`Issue #${issue.number}: ${issue.title}`);

		if (issue.body) {
			parts.push("", issue.body);
		}

		if (issue.comments.length > 0) {
			parts.push("", "### Comments");
			for (const c of issue.comments) {
				parts.push("", `**${c.author}:** ${c.body}`);
			}
		}

		parts.push("</user-content>");
		return parts.join("\n");
	}

	private formatComment(plan: string, hash: string): string {
		return [
			`## Implementation Plan <!-- agent-plan:hash=${hash} -->`,
			"",
			plan,
			"",
			"---",
			`*To approve, reply with exactly:*`,
			`\`\`\``,
			`agent: approved ${hash}`,
			`\`\`\``,
			`*Editing this comment will invalidate any existing approval.*`,
		].join("\n");
	}
}
