import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

export interface Limits {
  toolIterations: number;
  prFixIterations: number;
  planRetries: number;
  runtimeSeconds: number;
  commands: number;
  fileWrites: number;
  cmdOutputMaxTokens: number;
  tokensPerRun: number | null;
  issueFailures: number;
  consecutiveFailureThreshold: number;
}

export interface RepoConfig {
  allowlist: string[];
  skiplist: string[];
  requireIssueAllowlist: boolean;
  requiredLabels: string[];    // issue must have at least one; empty = no label filter
  priorityLabels: string[];   // ordered list — first match wins; unlabeled issues sort last
  commands: string[];
  rateLimitThreshold: number;
  limits: Limits;
}

export interface EnvConfig {
  githubToken: string;      // resolved by auth.ts — either GITHUB_TOKEN or minted App token
  anthropicApiKey: string;
  githubRepo: string;
  githubBotUsername: string;
  gitUserName: string;
  gitUserEmail: string;
  workDir: string;
  logDir: string;
  allowNetwork: boolean;
  dryRun: boolean;
}

export interface Config {
  env: EnvConfig;
  repo: RepoConfig;
}

const DEFAULTS: RepoConfig = {
  allowlist: [],
  skiplist: [],
  requireIssueAllowlist: true,
  requiredLabels: ['bug', 'enhancement', 'feature', 'documentation', 'refactor', 'chore'],
  priorityLabels: ['priority', '<none>', 'nice to have'],
  commands: [],
  rateLimitThreshold: 100,
  limits: {
    toolIterations: 25,
    prFixIterations: 10,
    planRetries: 2,
    runtimeSeconds: 600,
    commands: 20,
    fileWrites: 30,
    cmdOutputMaxTokens: 2000,
    tokensPerRun: null,
    issueFailures: 3,
    consecutiveFailureThreshold: 3,
  },
};

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Required env var ${name} is not set`);
  return val;
}

function envInt(name: string): number | undefined {
  const val = process.env[name];
  return val ? parseInt(val, 10) : undefined;
}

function envList(name: string): string[] | undefined {
  const val = process.env[name];
  return val ? val.split(',').map(s => s.trim()).filter(Boolean) : undefined;
}

export function loadEnvConfig(githubToken: string): EnvConfig {
  return {
    githubToken,
    anthropicApiKey: requireEnv('ANTHROPIC_API_KEY'),
    githubRepo: requireEnv('GITHUB_REPO'),
    githubBotUsername: requireEnv('GITHUB_BOT_USERNAME'),
    gitUserName: requireEnv('GIT_USER_NAME'),
    gitUserEmail: requireEnv('GIT_USER_EMAIL'),
    workDir: requireEnv('WORK_DIR'),
    logDir: requireEnv('LOG_DIR'),
    allowNetwork: process.env.ALLOW_NETWORK === 'true',
    dryRun: process.env.DRY_RUN === 'true',
  };
}

export function loadRepoConfig(workDir: string): RepoConfig {
  let fileConfig: Partial<RepoConfig & { limits: Partial<Limits> }> = {};

  for (const name of ['steward.json', '.steward.json', 'steward.config.json']) {
    const path = join(workDir, name);
    if (existsSync(path)) {
      try {
        fileConfig = JSON.parse(readFileSync(path, 'utf-8'));
      } catch (e) {
        throw new Error(`Failed to parse ${name}: ${e}`);
      }
      break;
    }
  }

  // Env var overrides (resolution order: env > file > defaults)
  const envOverrides: Partial<RepoConfig> = {};
  const limitsOverrides: Partial<Limits> = {};

  const allowlist = envList('AGENT_COMMENT_ALLOWLIST');
  if (allowlist) envOverrides.allowlist = allowlist;

  const skiplist = envList('AGENT_COMMENT_SKIPLIST');
  if (skiplist) envOverrides.skiplist = skiplist;

  if (process.env.REQUIRE_ISSUE_ALLOWLIST !== undefined)
    envOverrides.requireIssueAllowlist = process.env.REQUIRE_ISSUE_ALLOWLIST !== 'false';

  const requiredLabels = envList('REQUIRED_LABELS');
  if (requiredLabels) envOverrides.requiredLabels = requiredLabels;

  const priorityLabels = envList('PRIORITY_LABELS');
  if (priorityLabels) envOverrides.priorityLabels = priorityLabels;

  const commands = envList('COMMAND_ALLOWLIST');
  if (commands) envOverrides.commands = commands;

  const rateLimitThreshold = envInt('RATE_LIMIT_THRESHOLD');
  if (rateLimitThreshold !== undefined) envOverrides.rateLimitThreshold = rateLimitThreshold;

  const toolIterations = envInt('MAX_TOOL_ITERATIONS');
  if (toolIterations !== undefined) limitsOverrides.toolIterations = toolIterations;

  const prFixIterations = envInt('MAX_PR_FIX_ITERATIONS');
  if (prFixIterations !== undefined) limitsOverrides.prFixIterations = prFixIterations;

  const planRetries = envInt('MAX_PLAN_RETRIES');
  if (planRetries !== undefined) limitsOverrides.planRetries = planRetries;

  const runtimeSeconds = envInt('MAX_RUNTIME_SECONDS');
  if (runtimeSeconds !== undefined) limitsOverrides.runtimeSeconds = runtimeSeconds;

  const maxCommands = envInt('MAX_COMMANDS');
  if (maxCommands !== undefined) limitsOverrides.commands = maxCommands;

  const fileWrites = envInt('MAX_FILE_WRITES');
  if (fileWrites !== undefined) limitsOverrides.fileWrites = fileWrites;

  const cmdOutputMaxTokens = envInt('CMD_OUTPUT_MAX_TOKENS');
  if (cmdOutputMaxTokens !== undefined) limitsOverrides.cmdOutputMaxTokens = cmdOutputMaxTokens;

  const tokensPerRun = envInt('MAX_TOKENS_PER_RUN');
  if (tokensPerRun !== undefined) limitsOverrides.tokensPerRun = tokensPerRun;

  const issueFailures = envInt('MAX_ISSUE_FAILURES');
  if (issueFailures !== undefined) limitsOverrides.issueFailures = issueFailures;

  const consecutiveFailureThreshold = envInt('CONSECUTIVE_FAILURE_THRESHOLD');
  if (consecutiveFailureThreshold !== undefined) limitsOverrides.consecutiveFailureThreshold = consecutiveFailureThreshold;

  return {
    ...DEFAULTS,
    ...fileConfig,
    ...envOverrides,
    limits: {
      ...DEFAULTS.limits,
      ...(fileConfig.limits ?? {}),
      ...limitsOverrides,
    },
  };
}
