import { execFileSync } from "node:child_process";

const CHARS_PER_TOKEN = 4;

export function runCommand(
	workDir: string,
	allowlist: string[],
	command: string,
	args: string[],
	maxOutputTokens: number,
): string {
	// Validate against allowlist — match on executable name only
	const allowedEntry = allowlist.find(
		(entry) => entry.trim().split(/\s+/)[0] === command,
	);
	if (!allowedEntry) {
		const names = allowlist.map((e) => e.trim().split(/\s+/)[0]).join(", ");
		return `Error: '${command}' is not in the command allowlist. Allowed: ${names || "(none)"}`;
	}

	try {
		const stdout = execFileSync(command, args, {
			cwd: workDir,
			encoding: "utf-8",
			timeout: 120_000,
			stdio: ["pipe", "pipe", "pipe"],
		});
		return truncate(stdout, maxOutputTokens);
	} catch (e: unknown) {
		// execFileSync throws on non-zero exit; stdout/stderr are on the error object
		if (isExecError(e)) {
			const out = [e.stdout, e.stderr].filter(Boolean).join("\n");
			return `Exit ${e.status ?? 1}:\n${truncate(out, maxOutputTokens)}`;
		}
		return `Error: ${e}`;
	}
}

function truncate(output: string, maxTokens: number): string {
	const maxChars = maxTokens * CHARS_PER_TOKEN;
	if (output.length <= maxChars) return output;
	const half = Math.floor(maxChars / 2);
	const omitted = output.length - maxChars;
	return (
		output.slice(0, half) +
		`\n\n[... ${omitted} chars omitted — full output at $WORK_DIR/logs/last_command.txt ...]\n\n` +
		output.slice(-half)
	);
}

interface ExecError {
	stdout: string;
	stderr: string;
	status: number | null;
}

function isExecError(e: unknown): e is ExecError {
	return typeof e === "object" && e !== null && "stdout" in e;
}
