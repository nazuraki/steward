import { createHmac, timingSafeEqual } from "node:crypto";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import {
	Agent,
	type EnvConfig,
	Logger,
	loadEnvConfig,
	type RepoConfig,
	resolveGitHubToken,
	validate,
} from "@steward/runner";

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? "";
const WEBHOOK_EVENTS = (
	process.env.WEBHOOK_EVENTS ?? "issues,issue_comment,pull_request_review"
)
	.split(",")
	.map((s) => s.trim())
	.filter(Boolean);

let agentRunning = false;

function verifySignature(secret: string, body: Buffer, sig: string): boolean {
	const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
	try {
		return timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
	} catch {
		return false;
	}
}

function readBody(req: IncomingMessage): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}

function handleHook(
	req: IncomingMessage,
	res: ServerResponse,
	env: EnvConfig,
	repoConfig: RepoConfig,
): void {
	readBody(req)
		.then((body) => {
			const sig = (req.headers["x-hub-signature-256"] as string) ?? "";
			if (!verifySignature(WEBHOOK_SECRET, body, sig)) {
				res.writeHead(401).end();
				return;
			}

			const event = (req.headers["x-github-event"] as string) ?? "";
			if (!WEBHOOK_EVENTS.includes(event)) {
				res.writeHead(200).end();
				return;
			}

			// Acknowledge before any async work
			res.writeHead(202).end();

			if (agentRunning) {
				process.stderr.write(
					`[steward] event=${event} dropped — agent already running\n`,
				);
				return;
			}

			agentRunning = true;
			const runLogger = new Logger(env.githubRepo, env.logDir);
			process.stderr.write(
				`[steward] event=${event} starting run_id=${runLogger.runId}\n`,
			);

			const runtimeMs = repoConfig.limits.runtimeSeconds * 1000;
			const agent = new Agent(env, repoConfig, runLogger);

			Promise.race([
				agent.run(),
				new Promise<never>((_, reject) =>
					setTimeout(
						() =>
							reject(
								new Error(`run exceeded ${repoConfig.limits.runtimeSeconds}s`),
							),
						runtimeMs,
					),
				),
			])
				.then(() => {
					process.stderr.write(
						`[steward] run_id=${runLogger.runId} completed\n`,
					);
				})
				.catch((e: unknown) => {
					const msg = e instanceof Error ? e.message : String(e);
					runLogger.write("error", "error", { error: msg });
					process.stderr.write(
						`[steward] run_id=${runLogger.runId} error: ${msg}\n`,
					);
				})
				.finally(() => {
					agentRunning = false;
				});
		})
		.catch(() => {
			res.writeHead(400).end();
		});
}

export async function main(): Promise<void> {
	if (!WEBHOOK_SECRET) {
		process.stderr.write(
			"[steward] WEBHOOK_SECRET is required in webhook mode\n",
		);
		process.exit(1);
	}

	let githubToken: string;
	try {
		githubToken = await resolveGitHubToken();
	} catch (e: unknown) {
		process.stderr.write(`[steward] Auth error: ${e}\n`);
		process.exit(1);
	}

	let env: EnvConfig;
	try {
		env = loadEnvConfig(githubToken);
	} catch (e: unknown) {
		process.stderr.write(`[steward] Config error: ${e}\n`);
		process.exit(1);
	}

	// validate() runs once at startup, not per-event
	const startupLogger = new Logger(env.githubRepo, env.logDir);
	process.stderr.write(
		`[steward] webhook-loop startup run_id=${startupLogger.runId} repo=${env.githubRepo}\n`,
	);

	const validationResult = await validate(env);
	if (!validationResult.ok || !validationResult.repoConfig) {
		startupLogger.write("validation_failed", "error", {
			error: validationResult.error,
		});
		process.stderr.write(
			`[steward] Validation failed: ${validationResult.error}\n`,
		);
		process.exit(1);
	}
	const repoConfig: RepoConfig = validationResult.repoConfig;

	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		if (req.method === "POST" && req.url === "/hook") {
			handleHook(req, res, env, repoConfig);
		} else {
			res.writeHead(404).end();
		}
	});

	server.listen(PORT, () => {
		process.stderr.write(`[steward] webhook-loop listening on :${PORT}\n`);
	});
}

main();
