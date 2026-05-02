import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { v4 as uuidv4 } from "uuid";
import type { LogRecord, OutcomeType, TaskType } from "@steward/core";

export class Logger {
	readonly runId: string;
	private readonly startTime: number;
	private readonly repo: string;
	private readonly logDir: string;
	private tokens = { input: 0, output: 0, total: 0 };

	constructor(repo: string, logDir: string) {
		this.runId = uuidv4();
		this.startTime = Date.now();
		this.repo = repo;
		this.logDir = logDir;
		mkdirSync(logDir, { recursive: true });
	}

	addTokens(input: number, output: number): void {
		this.tokens.input += input;
		this.tokens.output += output;
		this.tokens.total += input + output;
	}

	getTotalTokens(): number {
		return this.tokens.total;
	}

	write(
		task: TaskType,
		outcome: OutcomeType,
		opts: {
			issue?: number;
			pr?: number;
			error?: string;
			conflict_files?: string[];
		} = {},
	): LogRecord {
		const record: LogRecord = {
			run_id: this.runId,
			timestamp: new Date().toISOString(),
			repo: this.repo,
			task,
			issue: opts.issue ?? null,
			pr: opts.pr ?? null,
			duration_ms: Date.now() - this.startTime,
			tokens: { ...this.tokens },
			outcome,
			error: opts.error ?? null,
			conflict_files: opts.conflict_files ?? null,
		};

		const line = JSON.stringify(record);
		appendFileSync(join(this.logDir, "runs.jsonl"), `${line}\n`, "utf-8");
		process.stdout.write(`${line}\n`);
		return record;
	}
}
