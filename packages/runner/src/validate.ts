import { execFileSync, execSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import type { EnvConfig, RepoConfig } from "@steward/config";
import { loadRepoConfig } from "@steward/config";
import { GitHubClient } from "@steward/gh-client";

export interface ValidationResult {
	ok: boolean;
	error?: string;
	repoConfig?: RepoConfig;
}

/**
 * Phase 0: Validate environment before any GitHub or AI work.
 * Returns a populated RepoConfig on success, an error string on failure.
 */
export async function validate(env: EnvConfig): Promise<ValidationResult> {
	// 1. git installed
	try {
		execFileSync("git", ["--version"], { stdio: "pipe" });
	} catch {
		return fail("git is not installed or not in PATH");
	}

	// 2. ANTHROPIC_API_KEY is reachable (lightweight probe)
	try {
		const client = new Anthropic({ apiKey: env.anthropicApiKey });
		await client.messages.create({
			model: "claude-haiku-4-5-20251001",
			max_tokens: 1,
			messages: [{ role: "user", content: "hi" }],
		});
	} catch (e: unknown) {
		const status = getStatus(e);
		const message = getAnthropicMessage(e);
		if (status === 401) return fail("ANTHROPIC_API_KEY is invalid or expired");
		if (status === 403)
			return fail(
				`Anthropic API access denied: ${message}. Check your credit balance and workspace at console.anthropic.com`,
			);
		if (status === 400) {
			/* max_tokens=1 may 400 on some models — key is fine */
		} else if (!status) return fail(`Cannot reach Anthropic API: ${e}`);
	}

	// 3. Verify GitHub token has repo access
	const gh = new GitHubClient(env.githubToken, env.githubRepo);
	let scopes: string[];
	try {
		scopes = await gh.getTokenScopes();
	} catch (e: unknown) {
		const status = getStatus(e);
		if (status === 401) return fail("GitHub token is invalid or expired");
		if (status === 404)
			return fail(
				`Repo ${env.githubRepo} not found or token lacks read access`,
			);
		return fail(`GitHub API error during validation: ${e}`);
	}

	// GitHub App installation tokens don't carry OAuth scopes — the header is empty.
	// Their permissions are set at the App level and enforced by the API, not headers.
	// Only check scopes for PATs and Actions tokens (which always have at least one scope).
	const usingAppAuth = !!(
		process.env.GITHUB_APP_ID &&
		process.env.GITHUB_APP_PRIVATE_KEY &&
		process.env.GITHUB_APP_INSTALLATION_ID
	);

	if (!usingAppAuth) {
		const hasRepoScope =
			scopes.includes("repo") || scopes.includes("public_repo");
		if (!hasRepoScope) {
			return fail(
				`GITHUB_TOKEN is missing required scope. Got: [${scopes.join(", ")}]. Need: repo (or public_repo for public repos)`,
			);
		}
	}

	// 4. Required env vars — already enforced by loadEnvConfig(), but double-check.
	// GITHUB_TOKEN is excluded here: auth.ts resolved it already (may have come from App credentials).
	for (const name of [
		"ANTHROPIC_API_KEY",
		"GITHUB_REPO",
		"GITHUB_BOT_USERNAME",
		"GIT_USER_NAME",
		"GIT_USER_EMAIL",
		"WORK_DIR",
		"LOG_DIR",
	]) {
		if (!process.env[name]) return fail(`Required env var ${name} is not set`);
	}

	// 5. Clone repo into WORK_DIR (wipe first — validates network, credentials, and repo in one step)
	try {
		rmSync(env.workDir, { recursive: true, force: true });
		mkdirSync(env.workDir, { recursive: true });

		const repoUrl = `https://x-access-token:${env.githubToken}@github.com/${env.githubRepo}.git`;
		execFileSync("git", ["clone", "--depth=1", repoUrl, env.workDir], {
			stdio: "pipe",
			timeout: 120_000,
		});

		// Configure git identity for commits
		execFileSync(
			"git",
			["-C", env.workDir, "config", "user.name", env.gitUserName],
			{ stdio: "pipe" },
		);
		execFileSync(
			"git",
			["-C", env.workDir, "config", "user.email", env.gitUserEmail],
			{ stdio: "pipe" },
		);
	} catch (e: unknown) {
		return fail(`Failed to clone ${env.githubRepo}: ${e}`);
	}

	// 6. Load repo config (steward.json / .steward.json) and merge with env overrides
	let repoConfig: RepoConfig;
	try {
		repoConfig = loadRepoConfig(env.workDir);
	} catch (e: unknown) {
		return fail(`Failed to load repo config: ${e}`);
	}

	// 7. Verify all allowlisted commands exist and are executable in the cloned repo
	for (const cmd of repoConfig.commands) {
		const parts = cmd.trim().split(/\s+/);
		const exe = parts[0];
		if (!exe) continue;

		try {
			// Check if the command is available in the repo's environment
			execSync(`command -v ${exe}`, {
				cwd: env.workDir,
				stdio: "pipe",
				shell: "/bin/sh",
			});
		} catch {
			return fail(
				`Allowlisted command '${exe}' (from '${cmd}') is not executable in ${env.workDir}. ` +
					`Fix the 'commands' list in steward.json or ensure the toolchain is installed in the Docker image.`,
			);
		}
	}

	return { ok: true, repoConfig };
}

function fail(error: string): ValidationResult {
	return { ok: false, error };
}

function getStatus(e: unknown): number | null {
	if (typeof e === "object" && e !== null && "status" in e) {
		return (e as { status: number }).status;
	}
	return null;
}

function getAnthropicMessage(e: unknown): string {
	if (typeof e === "object" && e !== null && "message" in e) {
		return String((e as { message: unknown }).message);
	}
	return String(e);
}
