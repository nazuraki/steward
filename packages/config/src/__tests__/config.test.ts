import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadEnvConfig, loadRepoConfig } from "../index.js";

describe("loadEnvConfig", () => {
	afterEach(() => vi.unstubAllEnvs());

	function stubRequired() {
		vi.stubEnv("ANTHROPIC_API_KEY", "sk-test");
		vi.stubEnv("GITHUB_REPO", "owner/repo");
		vi.stubEnv("GITHUB_BOT_USERNAME", "bot");
		vi.stubEnv("GIT_USER_NAME", "Bot");
		vi.stubEnv("GIT_USER_EMAIL", "bot@example.com");
		vi.stubEnv("WORK_DIR", "/tmp/work");
		vi.stubEnv("LOG_DIR", "/tmp/logs");
	}

	it("returns env config from environment", () => {
		stubRequired();
		const config = loadEnvConfig("ghp_token");
		expect(config.githubToken).toBe("ghp_token");
		expect(config.anthropicApiKey).toBe("sk-test");
		expect(config.githubRepo).toBe("owner/repo");
		expect(config.allowNetwork).toBe(false);
		expect(config.dryRun).toBe(false);
	});

	it("sets allowNetwork and dryRun from env", () => {
		stubRequired();
		vi.stubEnv("ALLOW_NETWORK", "true");
		vi.stubEnv("DRY_RUN", "true");
		const config = loadEnvConfig("token");
		expect(config.allowNetwork).toBe(true);
		expect(config.dryRun).toBe(true);
	});

	it("throws on missing required env var", () => {
		vi.stubEnv("ANTHROPIC_API_KEY", "");
		expect(() => loadEnvConfig("token")).toThrow("ANTHROPIC_API_KEY");
	});
});

describe("loadRepoConfig", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "steward-test-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
		vi.unstubAllEnvs();
	});

	it("returns defaults when no config file or env overrides", () => {
		const config = loadRepoConfig(tmpDir);
		expect(config.allowlist).toEqual([]);
		expect(config.skiplist).toEqual([]);
		expect(config.requireIssueAllowlist).toBe(true);
		expect(config.rateLimitThreshold).toBe(100);
		expect(config.limits.toolIterations).toBe(25);
		expect(config.models.plan).toBe("claude-sonnet-4-6");
	});

	it("loads steward.json and merges over defaults", () => {
		writeFileSync(
			join(tmpDir, "steward.json"),
			JSON.stringify({ allowlist: ["alice", "bob"], rateLimitThreshold: 50 }),
		);
		const config = loadRepoConfig(tmpDir);
		expect(config.allowlist).toEqual(["alice", "bob"]);
		expect(config.rateLimitThreshold).toBe(50);
		expect(config.requireIssueAllowlist).toBe(true);
	});

	it("loads .steward.json when steward.json is absent", () => {
		writeFileSync(
			join(tmpDir, ".steward.json"),
			JSON.stringify({ skiplist: ["bot"] }),
		);
		const config = loadRepoConfig(tmpDir);
		expect(config.skiplist).toEqual(["bot"]);
	});

	it("loads steward.config.json as last fallback", () => {
		writeFileSync(
			join(tmpDir, "steward.config.json"),
			JSON.stringify({ skiplist: ["ci"] }),
		);
		const config = loadRepoConfig(tmpDir);
		expect(config.skiplist).toEqual(["ci"]);
	});

	it("env vars override file config", () => {
		writeFileSync(
			join(tmpDir, "steward.json"),
			JSON.stringify({ rateLimitThreshold: 50 }),
		);
		vi.stubEnv("RATE_LIMIT_THRESHOLD", "200");
		const config = loadRepoConfig(tmpDir);
		expect(config.rateLimitThreshold).toBe(200);
	});

	it("env vars override defaults without a config file", () => {
		vi.stubEnv("AGENT_COMMENT_ALLOWLIST", "alice, bob, carol");
		const config = loadRepoConfig(tmpDir);
		expect(config.allowlist).toEqual(["alice", "bob", "carol"]);
	});

	it("REQUIRE_ISSUE_ALLOWLIST=false disables it", () => {
		vi.stubEnv("REQUIRE_ISSUE_ALLOWLIST", "false");
		const config = loadRepoConfig(tmpDir);
		expect(config.requireIssueAllowlist).toBe(false);
	});

	it("REQUIRE_ISSUE_ALLOWLIST set to any value other than false enables it", () => {
		vi.stubEnv("REQUIRE_ISSUE_ALLOWLIST", "true");
		const config = loadRepoConfig(tmpDir);
		expect(config.requireIssueAllowlist).toBe(true);
	});

	it("limit env vars override defaults", () => {
		vi.stubEnv("MAX_TOOL_ITERATIONS", "50");
		vi.stubEnv("MAX_FILE_WRITES", "10");
		const config = loadRepoConfig(tmpDir);
		expect(config.limits.toolIterations).toBe(50);
		expect(config.limits.fileWrites).toBe(10);
		expect(config.limits.prFixIterations).toBe(10);
	});

	it("env limit wins over file limit, file limit wins over default", () => {
		writeFileSync(
			join(tmpDir, "steward.json"),
			JSON.stringify({ limits: { toolIterations: 30, prFixIterations: 5 } }),
		);
		vi.stubEnv("MAX_TOOL_ITERATIONS", "40");
		const config = loadRepoConfig(tmpDir);
		expect(config.limits.toolIterations).toBe(40);
		expect(config.limits.prFixIterations).toBe(5);
		expect(config.limits.planRetries).toBe(2);
	});

	it("models from file are merged over defaults", () => {
		writeFileSync(
			join(tmpDir, "steward.json"),
			JSON.stringify({ models: { plan: "claude-opus-4-7" } }),
		);
		const config = loadRepoConfig(tmpDir);
		expect(config.models.plan).toBe("claude-opus-4-7");
		expect(config.models.implement).toBe("claude-sonnet-4-6");
	});

	it("throws on invalid JSON", () => {
		writeFileSync(join(tmpDir, "steward.json"), "{ invalid json }");
		expect(() => loadRepoConfig(tmpDir)).toThrow(
			"Failed to parse steward.json",
		);
	});
});
