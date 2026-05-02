import { Agent } from "./agent.js";
import { resolveGitHubToken } from "@steward/auth";
import { type EnvConfig, loadEnvConfig, type RepoConfig } from "@steward/config";
import { Logger } from "./logger.js";
import { validate } from "./validate.js";

async function main(): Promise<void> {
	// Resolve GitHub token first — may involve an async App token exchange
	let githubToken: string;
	try {
		githubToken = await resolveGitHubToken();
	} catch (e: unknown) {
		process.stderr.write(`[steward] Auth error: ${e}\n`);
		process.exit(1);
	}

	// Load remaining required env vars (throws on missing)
	let env: EnvConfig;
	try {
		env = loadEnvConfig(githubToken);
	} catch (e: unknown) {
		process.stderr.write(`[steward] Startup error: ${e}\n`);
		process.exit(1);
	}

	const logger = new Logger(env.githubRepo, env.logDir);
	process.stderr.write(
		`[steward] run_id=${logger.runId} repo=${env.githubRepo}\n`,
	);

	// Hard wall-clock timeout — set up before any async work
	// We install this here so it covers validation + agent loop.
	// Actual runtimeSeconds comes from repo config, but that's loaded during validation.
	// Use a generous default (10 min) until the real limit is known.
	const STARTUP_TIMEOUT_MS = 600_000;
	let timeoutHandle: ReturnType<typeof setTimeout> | null = setTimeout(
		async () => {
			logger.write("error", "timeout", {
				error: "MAX_RUNTIME_SECONDS exceeded before config loaded",
			});
			process.exit(1);
		},
		STARTUP_TIMEOUT_MS,
	);

	// ── Phase 0: validation ────────────────────────────────────────────────────
	let repoConfig: RepoConfig;
	{
		const result = await validate(env);
		if (!result.ok || !result.repoConfig) {
			clearTimeout(timeoutHandle);
			logger.write("validation_failed", "error", { error: result.error });
			process.exit(1);
		}
		repoConfig = result.repoConfig;
	}

	// Now that we have the real runtimeSeconds, reset the timeout
	clearTimeout(timeoutHandle);
	const runtimeMs = repoConfig.limits.runtimeSeconds * 1000;
	timeoutHandle = setTimeout(async () => {
		logger.write("error", "timeout", {
			error: `Run exceeded MAX_RUNTIME_SECONDS (${repoConfig.limits.runtimeSeconds}s)`,
		});
		process.exit(1);
	}, runtimeMs);

	// ── Agent loop ─────────────────────────────────────────────────────────────
	try {
		const agent = new Agent(env, repoConfig, logger);
		await agent.run();
	} catch (e: unknown) {
		clearTimeout(timeoutHandle);
		const msg = e instanceof Error ? e.message : String(e);
		logger.write("error", "error", { error: msg });
		process.stderr.write(`[steward] Unhandled error: ${e}\n`);
		process.exit(1);
	}

	clearTimeout(timeoutHandle);
	process.exit(0);
}

main();
