# GitHub Agent — Implementation Plan

## Overview

A single-pass CLI agent that runs one work cycle per invocation, designed to be triggered on a schedule (cron, GitHub Actions timer, etc.). Docker provides the isolated execution environment. Each run produces a structured log entry for monitoring over time.

---

## Agent Loop Logic

The agent is an **orchestrator program** — most of the loop is plain script logic making GitHub API calls. The AI is invoked only at three specific points, marked below. This keeps token usage minimal and the control flow auditable.

```
Start
  → Phase 0 validation (see below) — exit with error if fails
  → [ORCHESTRATOR] Check GitHub rate limit — if remaining < threshold, log idle + exit

  → [ORCHESTRATOR] Fetch open PRs with unresolved review comments
      → Filter out threads where all comments are from the skiplist
      → If allowlist is configured, only consider threads with ≥1 allowlist commenter
      → Filter out threads already marked processed (see Thread Dedup below)
  → If qualifying threads found:
      → Pick the highest-priority PR (oldest-updated; tie-break by lowest PR number)
      → For each unresolved thread:
          → [ORCHESTRATOR] Fetch diff hunk + full file for the thread
      → [AI: PR FIX] Given all thread contexts → produce code fixes via tool-use loop
      → [ORCHESTRATOR] Make a single commit covering all fixes
      → [ORCHESTRATOR] Push branch
      → [ORCHESTRATOR] Upsert agent-processed-threads PR comment
      → [ORCHESTRATOR] Re-request review via API (once, after push)
      → Log task=pr_review, pr=#, exit

  → [ORCHESTRATOR] Fetch open issues in priority order
      → Exclude issues labeled `agent:blocked`
      → Exclude issues that already have an open PR with head branch matching agent/issue-{N}-*
      → Unless REQUIRE_ISSUE_ALLOWLIST=false, only consider issues where:
          - the issue author is on the allowlist, OR
          - an allowlist user has commented with `agent: consider`
      → Non-qualifying issues are silently skipped (not logged individually)
  → If none: log task=idle, exit

  → Iterate issues in priority order:
      → If issue has no plan:
          → [AI: PLAN] Given issue title + body + comments → produce implementation plan
          → If plan exceeds size cap: retry with stricter prompt (max MAX_PLAN_RETRIES times)
          → If still oversized: log task=plan_failed, exit
          → [ORCHESTRATOR] Post plan as issue comment with marker <!-- agent-plan:hash={content_hash} -->
          → Log task=plan, issue=#, exit
      → If issue has a plan but no matching approval: skip (continue to next issue)
      → If issue has an approved plan:
          → [ORCHESTRATOR] Create branch: agent/issue-{N}-{short-slug}
          → [ORCHESTRATOR] Fetch and rebase from main before starting
          → [AI: IMPLEMENT] Given plan + repo access via tool-use loop → implement solution
          → [ORCHESTRATOR] Rebase from main before push
          → If merge conflict: abort, delete branch, increment failure count for this issue (see Failure Backoff), log task=implement_conflict, exit
          → [ORCHESTRATOR] Commit, push branch
          → [ORCHESTRATOR] Open PR (title from issue title; body from template — see PR Format)
          → [AI: REVIEW] Self-review the diff — check for missed requirements, bugs, style issues
          → If review finds issues: post them as PR review comments, log task=implement_reviewed, exit
          → If review is clean: log task=implement, issue=#, pr=#, exit

  → If all issues were skipped (all awaiting approval):
      → Log task=awaiting_approval, exit
```

One exit point per run. Stateless by design — all state lives in GitHub. The issue queue is iterated so that a blocked (awaiting approval) issue never prevents work on other issues.

**Timeout behavior:** If `MAX_RUNTIME_SECONDS` fires mid-run, push any commits that exist (partial progress is better than none), post a comment on the active issue or PR noting the timeout and run ID, then exit with `outcome=timeout`. This is the one case where an unsolicited bot comment on an issue is warranted — a human needs to know the run was incomplete.

### AI Invocation Summary

| Invocation | Input | Output | Loop? |
|---|---|---|---|
| **PR FIX** | All unresolved thread diff hunks + file contexts | Code changes via tool calls | Yes (capped at `MAX_PR_FIX_ITERATIONS`) |
| **PLAN** | Issue title, body, and comments | Markdown implementation plan (size-capped) | No |
| **IMPLEMENT** | Approved plan, tool-use access to repo filesystem and shell | Code changes via tool calls | Yes (capped at `MAX_TOOL_ITERATIONS`) |
| **REVIEW** | PR diff + approved plan | Review comments or clean approval | No |

PR FIX reuses the IMPLEMENT tool loop with a lower iteration cap. PLAN and REVIEW are single-turn completions.

---

## Phase 0: Environment Validation

Runs before any GitHub or AI logic. Fails fast with a clear error rather than consuming a cron slot silently.

1. Verify `git` is installed and executable.
2. Verify `ANTHROPIC_API_KEY` is set and reachable (lightweight no-op prompt).
3. Verify `GITHUB_TOKEN` has write access to `GITHUB_REPO` (read repo metadata; check scopes header).
4. Verify required env vars are present (`GITHUB_REPO`, `GITHUB_BOT_USERNAME`, `WORK_DIR`, `LOG_DIR`).
5. Clone the repo into `WORK_DIR` (wipe first if exists). Validates network access, credentials, and repo availability in one step. Avoids consuming a full cron slot on triage only to discover the clone fails.
6. Load repo config from `steward.json` or `.steward.json` at repo root (first found wins). Merge with env var overrides. Apply built-in defaults for any missing keys.
7. Verify that every command in the `commands` allowlist exists and is executable in the cloned repo environment. A whitelist pointing to a missing test runner is worse than no whitelist — the AI would think tests ran.

Log `task=validation_failed, outcome=error` and exit non-zero if any check fails.

---

## AI Tool Set

The agent exposes these tools to the AI during the IMPLEMENT and PR FIX phases:

| Tool | Purpose |
|---|---|
| `read_file` | Read file contents by path |
| `write_file` | Write/overwrite a file (auto-creates parent directories) |
| `list_directory` | Browse repo structure |
| `run_command` | Run allowlisted commands via subprocess argv (no shell); AI supplies command name + args as structured list |
| `search_code` | Search across the codebase |
| `get_issue_details` | Fetch the current work item's issue + comments |
| `post_comment` | Post a comment to the current work item's issue or PR |

**Tool scope:** `get_issue_details` and `post_comment` are scoped to the current work item only. The orchestrator injects the target issue/PR number at invocation time and the tool implementations enforce it — the AI cannot reach arbitrary issues or PRs.

**Context strategy:** Do not dump the full repo into the prompt. Feed the issue and plan, then let the AI pull in what it needs via `list_directory` and `read_file`. This keeps token usage bounded and mirrors how a developer actually explores a codebase.

### AI System Prompt

Every AI invocation (PLAN, IMPLEMENT, PR FIX) includes a system prompt assembled by the orchestrator. The prompt contains:

1. **Role and constraints** — agent identity, iteration limits, tool descriptions, formatting expectations.
2. **Repo-specific guidance** — the orchestrator reads `CONTRIB-agents.md` and `CONTEXT.md` from the repo root at the script layer (not via AI tool call) and injects their contents as static text in the system prompt under a clear header. The AI never reads these files itself — this eliminates them as a prompt injection vector. If a file doesn't exist, its section is omitted entirely.
3. **Task payload** — varies by invocation type (issue body + comments for PLAN; approved plan for IMPLEMENT; review threads + diff hunks for PR FIX).
4. **Untrusted content framing** — all user-supplied content (issue titles, bodies, comments, review threads) is wrapped in clear delimiters (e.g., `<user-content>...</user-content>`) and the system prompt explicitly instructs the AI that content between those delimiters is untrusted data, not instructions to follow. This mitigates prompt injection via issue content.

`CONTRIB-agents.md` is intended for repo owners to provide agent-specific contribution guidelines (e.g., "always run `make lint` before committing", "never modify files under `vendor/`"). `CONTEXT.md` provides general project context (architecture, conventions, key decisions). Both are optional. Together with `steward.json` (or `.steward.json`), these three files form the repo-level agent configuration surface.

### Tool Implementation Notes

**`write_file`:** Always perform the equivalent of `mkdir -p` on the target path before writing. Never fail on a missing parent directory.

**`read_file` (non-existent path):** Return an error that includes a short list of similarly-named files found via `search_code` logic. Allows the AI to self-correct on hallucinated paths without an extra round-trip.

**`search_code`:** Executes ripgrep (literal string match by default; regex mode available via a flag in the tool input). Results are truncated at a configurable line limit if the match set is large, with a note indicating truncation.

**`run_command` allowlist + isolation:** Commands are restricted to the `commands` allowlist in the repo config file (e.g. test runner, linter, build tool). **Commands must be executed via subprocess with an argv list, never via a shell string.** The allowlist validates the exact command name, and the orchestrator constructs the argv array — the AI supplies arguments as a structured list in the tool call, not as a freeform string. This prevents shell injection (e.g., `pytest --co -q; curl evil.com` is impossible when there is no shell to interpret the `;`). Default Docker network mode is `none`. Set `ALLOW_NETWORK=true` to use bridge mode for repos that require network access during build/test (dep installs, etc.). Explicit opt-in, not the default.

**`run_command` output truncation:** If output exceeds `CMD_OUTPUT_MAX_TOKENS`, truncate the middle, preserve head and tail, and append: *"Output truncated. Full output saved to `$WORK_DIR/logs/last_command.txt`. Use `read_file` to inspect specific sections."*

---

## PR Format

PR title: the issue title verbatim.

PR body template:
```
Closes #{issue_number}

## Summary
{one-paragraph summary generated by the orchestrator from the approved plan}

## Test results
{linter/test run_command output summary — pass/fail + key lines}

---
*Implemented by gh-agent — run {run_id}*
```

The agent opens the PR and exits. It does not wait for CI. CI is the final gate on correctness; the PR description gives reviewers enough context to evaluate the change before CI completes.

---

## Project Structure

```
gh-agent/
├── src/
│   ├── index          # Entry point — loads config, runs Phase 0, starts agent loop
│   ├── agent          # Main loop: rate limit check → PR triage → issue triage → dispatch
│   ├── github         # GitHub API wrapper (PRs, issues, comments, branches, reviews)
│   ├── planner        # Plan generation, size cap enforcement, retry logic
│   ├── implementer    # Agentic tool-use loop — shared by IMPLEMENT and PR FIX
│   ├── reviewer       # PR comment resolution logic
│   ├── logger         # Structured JSON log writer
│   └── tools/
│       ├── filesystem  # read_file, write_file, list_directory
│       ├── shell       # run_command with whitelist enforcement and output truncation
│       └── search      # search_code (ripgrep wrapper)
├── Dockerfile
├── docker-compose.yml
├── .env.example
└── [package manifest]
```

---

## Configuration

Configuration is split between **environment variables** (secrets, deployment topology, invocation-time toggles) and a **repo config file** (behavior tuning, access control, command allowlist). The repo config file is the source of truth for repo-specific settings; any key can be overridden by a corresponding env var for deployment flexibility.

### Environment Variables

```
# Required
GITHUB_TOKEN=                        # needs repo scope; workflow scope if org repo
ANTHROPIC_API_KEY=
GITHUB_REPO=owner/repo

# Agent identity
GITHUB_BOT_USERNAME=                 # used to identify the bot's own comments
GIT_USER_NAME=                       # used for git commit author (e.g. "My Bot")
GIT_USER_EMAIL=                      # use GitHub noreply: ID+username@users.noreply.github.com

# Docker / runtime environment
WORK_DIR=/tmp/repo                   # fresh clone target each run; wiped at start of Phase 0
LOG_DIR=/var/log/gh-agent            # mount a volume here to persist logs
ALLOW_NETWORK=false                  # set true for repos requiring network during build/test

# Invocation-time toggles
DRY_RUN=false                        # set true to log all actions without any writes
```

### Repo Config File

The agent looks for `steward.json` or `.steward.json` at the repo root (checked in that order; first found wins). This file is read by the orchestrator during Phase 0 after the clone. All fields are optional — defaults are applied for any missing key.

```json
{
  "allowlist": ["user1", "user2"],
  "skiplist": ["dependabot[bot]", "github-actions[bot]"],
  "requireIssueAllowlist": true,
  "priorityLabel": "priority:high",
  "commands": ["npm test", "npm run lint"],
  "rateLimitThreshold": 100,
  "limits": {
    "toolIterations": 25,
    "prFixIterations": 10,
    "planRetries": 2,
    "runtimeSeconds": 600,
    "commands": 20,
    "fileWrites": 30,
    "cmdOutputMaxTokens": 2000,
    "tokensPerRun": null,
    "issueFailures": 3,
    "consecutiveFailureThreshold": 3
  }
}
```

| Field | Default | Purpose |
|---|---|---|
| `allowlist` | `[]` (no filtering) | Users who can trigger work (issues + PR threads) |
| `skiplist` | `[]` | Bot/CI users to ignore in PR thread triage |
| `requireIssueAllowlist` | `true` | Set `false` for private repos to process issues from any user |
| `priorityLabel` | `"priority:high"` | Label that elevates an issue to top of queue |
| `commands` | `[]` | Allowlisted commands the AI can run (test runners, linters, build tools) |
| `rateLimitThreshold` | `100` | Exit early if GitHub API remaining calls below this |
| `limits.toolIterations` | `25` | Hard ceiling on AI tool-use loop (IMPLEMENT) |
| `limits.prFixIterations` | `10` | Lower ceiling for PR FIX tool-use loop |
| `limits.planRetries` | `2` | Max retries if PLAN output exceeds size cap |
| `limits.runtimeSeconds` | `600` | Hard wall-clock limit per run |
| `limits.commands` | `20` | Max `run_command` calls per run |
| `limits.fileWrites` | `30` | Max `write_file` calls per run |
| `limits.cmdOutputMaxTokens` | `2000` | Truncation threshold for `run_command` output |
| `limits.tokensPerRun` | `null` (no limit) | Cumulative token ceiling across all AI calls in one run |
| `limits.issueFailures` | `3` | Consecutive failures before applying `agent:blocked` label |
| `limits.consecutiveFailureThreshold` | `3` | Consecutive error outcomes before posting alert issue |

**Env var override:** Any repo config key can be overridden by setting a corresponding env var (e.g., `MAX_RUNTIME_SECONDS=300` overrides `limits.runtimeSeconds`). This allows a GitHub Actions workflow to tighten limits for a specific schedule without modifying the repo config. Env var names use the `SCREAMING_SNAKE_CASE` equivalents shown below:

| Repo config key | Env var override |
|---|---|
| `allowlist` | `AGENT_COMMENT_ALLOWLIST` (comma-separated) |
| `skiplist` | `AGENT_COMMENT_SKIPLIST` (comma-separated) |
| `requireIssueAllowlist` | `REQUIRE_ISSUE_ALLOWLIST` |
| `priorityLabel` | `PRIORITY_LABEL` |
| `commands` | `COMMAND_ALLOWLIST` (comma-separated) |
| `rateLimitThreshold` | `RATE_LIMIT_THRESHOLD` |
| `limits.toolIterations` | `MAX_TOOL_ITERATIONS` |
| `limits.prFixIterations` | `MAX_PR_FIX_ITERATIONS` |
| `limits.planRetries` | `MAX_PLAN_RETRIES` |
| `limits.runtimeSeconds` | `MAX_RUNTIME_SECONDS` |
| `limits.commands` | `MAX_COMMANDS` |
| `limits.fileWrites` | `MAX_FILE_WRITES` |
| `limits.cmdOutputMaxTokens` | `CMD_OUTPUT_MAX_TOKENS` |
| `limits.tokensPerRun` | `MAX_TOKENS_PER_RUN` |
| `limits.issueFailures` | `MAX_ISSUE_FAILURES` |
| `limits.consecutiveFailureThreshold` | `CONSECUTIVE_FAILURE_THRESHOLD` |

**Resolution order:** env var > repo config file > built-in default.

---

## Structured Logging

Each run appends one JSON record to `$LOG_DIR/runs.jsonl`. Log rotation is handled in the Docker setup phase (size- or age-based; implementation TBD).

```json
{
  "run_id": "a3f2c1d4-7e6b-4c2a-9f1d-3b8e5a2c0d9f",
  "timestamp": "2026-03-14T12:00:00Z",
  "repo": "owner/repo",
  "task": "implement | implement_reviewed | plan | pr_review | awaiting_approval | idle | plan_failed | implement_conflict | validation_failed | error",
  "issue": 42,
  "pr": null,
  "duration_ms": 12400,
  "tokens": {
    "input": 18200,
    "output": 3100,
    "total": 21300
  },
  "outcome": "success | error | timeout | budget_exceeded",
  "error": null,
  "conflict_files": null
}
```

`run_id` is a full UUID (v4) generated at startup, present on every log record. Allows correlation across multi-line output and crash traces. `issue` and `pr` are null when not applicable. Token counts are accumulated across all AI calls within a single run. `conflict_files` is populated only when `task=implement_conflict` — an array of file paths that had merge conflicts, extracted from the rebase output. Essential for debugging recurring conflicts.

---

## Docker Setup

The Dockerfile defines a base image (agent runtime + git) that can be extended for the target repo's toolchain. Image selection is the scheduler's responsibility — the agent has no opinion on which image it runs in.

Default `docker run` flags:
- `--network none` unless `ALLOW_NETWORK=true`
- No `--privileged`, no Docker socket mount
- Log volume mounted at `$LOG_DIR`
- All secrets via env vars, not baked into image
- Scheduler (e.g. GitHub Actions `concurrency` group) prevents overlapping runs — not handled inside the agent

Log rotation for `runs.jsonl` is configured here (e.g. logrotate, size cap, or age-based pruning).

---

## Priority Selection

**PRs:** Sort by oldest-updated first; tie-break by lowest PR number.

**Issues:** Issues labeled `$PRIORITY_LABEL` sort to the top; within each priority tier, sort oldest-created first (prevents new issues from starving older ones); tie-break by lowest issue number for determinism across runs. Issues are excluded if an open PR already exists with a head branch matching `agent/issue-{N}-*` (checked against open PRs, not branch existence — a deleted branch does not re-trigger work).

---

## Plan Approval Flow

1. Agent posts plan comment with marker `<!-- agent-plan:hash={content_hash} -->` where `content_hash` is a SHA-256 hash of the plan body text. Includes note: *"Reply with `agent: approved` to begin implementation."*
2. On subsequent runs, the agent locates the plan comment, recomputes the hash from the current plan body, and checks for an approval comment containing both `agent: approved` and a matching `hash` value, from a qualifying user (allowlist if configured, otherwise any non-skiplist human).
3. If the plan comment has been edited, the recomputed hash will differ from the hash in any existing approval. The prior approval is invalid. The agent posts a fresh versioned plan comment with the new hash and a note that the previous plan was superseded, then requires fresh approval. This keeps the audit trail clean — every approved plan is immutable.
4. If approved: proceed to implementation.
5. If not approved: skip and continue down the priority queue. Log `task=awaiting_approval` only if every candidate issue is in this state.

**Why content hash, not comment ID:** GitHub comment IDs are stable across edits — editing a comment does not change its ID. A scheme relying on comment ID changes to detect edits would silently fail. The content hash catches any modification to the plan body.

**Plan size cap:** PLAN output is rejected and retried (up to `MAX_PLAN_RETRIES`) with a stricter prompt if it exceeds 200 lines or 8,000 characters. On exhaustion, log `task=plan_failed` and exit. Oversized plans typically indicate the AI is including implementation detail that belongs in code, not the plan.

**Stale plans:** If an issue is edited after the plan is approved, the agent will implement from the original plan. This is by design — edits after approval require the human to delete the approval comment and re-approve the updated plan. Document this in the plan comment itself.

---

## Thread Dedup for PR Review

Before processing any review run, the orchestrator builds a set of already-handled thread IDs from two sources:

1. **PR comment marker:** Check for an existing PR comment (posted by `GITHUB_BOT_USERNAME`) containing `agent-processed-threads` with a JSON list of thread IDs.
2. **Commit history fallback:** Scan PR commits for messages matching `fix: address N review comment(s) [agent]`. If such commits exist but the dedup comment is missing (e.g., manually deleted), treat those threads as processed.

Threads in the combined set are skipped even if still technically unresolved in GitHub's API.

After all fixes are applied and pushed, the orchestrator upserts the dedup comment with the full updated list.

This prevents double-fixing if a run crashes after push but before logging, if GitHub's resolved state lags, or if someone manually deletes the dedup comment.

---

## PR Comment Resolution Detail

1. Fetch all review comment threads on the PR.
2. Filter: skip threads where every comment author is on the skiplist.
3. Filter: skip threads listed in the `agent-processed-threads` PR comment.
4. Fetch diff hunk and full file for all remaining threads.
5. Feed all threads and their context to AI in a single PR FIX invocation (tool-use loop, capped at `MAX_PR_FIX_ITERATIONS`). AI applies fixes via `write_file` calls.
6. Make a **single commit** covering all fixes: `fix: address N review comment(s) [agent]`.
7. Push.
8. Upsert `agent-processed-threads` PR comment with all processed thread IDs.
9. Re-request review from original reviewers — once.

---

## Branch Naming

Format: `agent/issue-{N}-{short-slug}`

- `short-slug` is derived from the issue title: lowercased, non-alphanumeric characters replaced with hyphens, consecutive hyphens collapsed, truncated to 40 characters, trailing hyphens stripped.
- Example: "Add user authentication endpoint" → `agent/issue-42-add-user-authentication-endp`

---

## Work Directory Lifecycle

`WORK_DIR` is wiped and re-cloned fresh during Phase 0 validation. There is no reuse of prior clones. This avoids stale state from previous runs and ensures the agent always works from a clean checkout. Cloning during Phase 0 (rather than immediately before IMPLEMENT) ensures clone failures — private dependencies, large repo, network timeout — fail fast before the agent spends time on triage.

---

## Failure Backoff for Issues

An issue that repeatedly fails (e.g., persistent merge conflicts, implementation errors) must not block the queue. The agent tracks consecutive failures per issue using GitHub issue labels:

- On any implementation failure (`implement_conflict`, `outcome=error` during IMPLEMENT), the orchestrator checks for existing `agent:failures:N` labels on the issue.
- Increment the count. If the count reaches `MAX_ISSUE_FAILURES` (default 3), apply the `agent:blocked` label and remove the failure counter labels.
- Issues labeled `agent:blocked` are skipped during triage until a human removes the label.

This uses GitHub as the state store (consistent with the stateless design) and is visible to humans in the issue sidebar.

---

## Dry-Run Mode

When `DRY_RUN=true`, the agent executes the full loop — triage, plan generation, implementation — but gates all external writes:

- No GitHub comments posted, PRs opened, or branches pushed.
- No `write_file` calls executed against the repo (AI tool calls are logged but not applied).
- All actions that would have been taken are logged to `$LOG_DIR/dry-run-{run_id}.json` with full detail: which issue was selected, what plan was generated, what files would have been written, what PR would have been opened.

Essential for testing against a real repo before going live, and for debugging when the agent misbehaves.

---

## Cost Budget Enforcement

`MAX_TOKENS_PER_RUN` (default: configurable, no default — opt-in) sets a cumulative token ceiling across all AI invocations within a single run. The orchestrator tracks input + output tokens after each AI call. If the cumulative total exceeds the limit, the current phase is aborted gracefully: any in-progress work is committed and pushed as partial progress (same as timeout behavior), and the run exits with `outcome=budget_exceeded`.

The log record already includes token counts. Budget enforcement adds a check between AI calls, not a new logging mechanism.

Daily/monthly budget alerting is deferred — the `runs.jsonl` data supports external dashboards and alerts without agent-side logic.

---

## Failure Notifications

If `outcome=error` occurs for `CONSECUTIVE_FAILURE_THRESHOLD` (default 3) consecutive runs, the agent posts a GitHub issue in the target repo titled `[steward] Agent failing — N consecutive errors` with the last N error messages from `runs.jsonl`. This uses the existing GitHub API integration and requires no external notification service.

The issue is tagged `agent:alert` and deduplicated — if an open issue with that tag already exists, the agent appends a comment instead of creating a new issue. The alert issue is closed automatically on the next successful run.

---

## Considered and Deferred

These items were evaluated during design review and intentionally deferred:

**Rollback capability** — An `agent: rollback #PR` trigger that creates a revert commit. Deferred because rollback is a procedural concern handled by existing GitHub UI (revert button) and team workflow, not an agent responsibility. Adding automated rollback introduces risk (reverting the wrong thing) without meaningful time savings.

**CI failure follow-up** — Having the agent watch for CI failures on its own PRs and trigger a follow-up PR FIX run against CI output. Deferred because it's a meaningful scope expansion that requires new state tracking (which PRs are "mine and failing") and introduces a feedback loop between the agent and CI that needs careful design. Worth revisiting after the core loop is proven.

**Branch protection awareness** — Querying branch protection rules in Phase 0 to warn about signed commits, status check requirements, or push restrictions. Deferred because the failure mode is obvious (PR is blocked) and self-diagnosing. Low risk of silent failure.

**Agent memory / learning loop** — A mechanism for the agent to learn from past mistakes on a specific repo (e.g., "last time I touched auth.py I introduced a regression"). Deferred as a future direction. The deterministic orchestration must work reliably first. Designing the log schema and plan comment structure to support future learning is worthwhile; building the learning layer is not yet warranted.

---

## Deployment Model

One Steward instance serves one repo. The command allowlist, `WORK_DIR`, Docker image, and all configuration are scoped to a single repository. A Python repo and a Node repo require two separate Steward instances with different allowlists and potentially different base Docker images.

This is by design — per-repo configuration keeps the agent simple and avoids cross-repo state leakage. Multi-repo orchestration (scheduling multiple Steward instances) is the scheduler's responsibility, not the agent's.

---

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Runaway tool-use loop | `MAX_TOOL_ITERATIONS`, `MAX_RUNTIME_SECONDS`, `MAX_COMMANDS`, `MAX_FILE_WRITES` hard limits |
| Scope creep in implementation | AI implements the plan, not the raw issue; plan approved before any code written |
| Agent/CI comment loop | Skiplist filters bot and CI commenters from PR triage |
| `run_command` network abuse | Default `--network none`; opt-in `ALLOW_NETWORK=true` for repos requiring it |
| Token cost on large repos | Context-on-demand strategy; `run_command` output truncation |
| Auth scope insufficient in org repos | Phase 0 validates scopes at startup; fail fast with clear error |
| GitHub rate limits | Rate limit checked before loop begins; exit early if below threshold |
| Implementation produces broken code | Linter/tests run at end of tool-use loop; result included in PR description; CI is final gate |
| AI hallucinates file paths | `read_file` returns similar-file suggestions on miss; `write_file` auto-creates directories |
| Overlapping runs | Scheduler-level concurrency lock; not handled inside the agent |
| Double-fixing PR threads | Thread IDs recorded in PR comment after each run; commit history checked as fallback if dedup comment is deleted |
| Stale plan approval | Approval tied to content hash of plan body; editing the plan changes the hash, invalidating prior approval |
| Stuck issue blocking the queue | Issue queue iterated; awaiting-approval issues skipped, not blocking |
| Old issues starved by new ones | Within priority tier, sort oldest-created first; tie-break by issue number |
| Oversized plan blowing IMPLEMENT context | Plan capped at 200 lines / 8k chars; retry up to `MAX_PLAN_RETRIES`; log `plan_failed` on exhaustion |
| Deleted branch re-triggering work | Existing-work detection queries open PRs by head branch pattern, not branch existence |
| Mid-run timeout leaving partial work | On timeout: push existing commits, post timeout comment with run ID, exit with `outcome=timeout` |
| Merge conflict during implementation | Rebase from main before push; on conflict abort, delete branch, log `implement_conflict` |
| AI tool accessing wrong issue/PR | `get_issue_details` and `post_comment` scoped to current work item; enforced at tool level |
| Stale plan implemented after issue edit | Documented behavior: humans must delete approval and re-approve after editing an issue |
| Untrusted users filing issues on public repos | `REQUIRE_ISSUE_ALLOWLIST=true` by default; gates issue triage to allowlist authors or explicit `agent: consider`; disable for private repos |
| Repeatedly-failing issue blocks queue | After `MAX_ISSUE_FAILURES` consecutive failures, apply `agent:blocked` label; skip until human removes it |
| Shell injection via `run_command` | Commands executed via subprocess argv list, never shell strings; AI supplies arguments as structured list |
| Prompt injection via repo guidance files | `CONTRIB-agents.md` and `CONTEXT.md` read by orchestrator at script layer, injected as static system prompt text; AI never reads these via tool call |
| Prompt injection via issue content | All user-supplied content wrapped in `<user-content>` delimiters; system prompt marks content as untrusted data |
| Missing command in allowlist | Phase 0 validates all allowlisted commands exist and are executable before any work begins |
| Unnoticed consecutive failures | After N consecutive `outcome=error` runs, agent posts alert issue in target repo; auto-closes on recovery |

---

## Phased Build Order

**Phase 0 — Environment validation**
Startup checks: git, API key reachability, GitHub token scopes, required env vars, repo clone, command allowlist validation. Sets the fail-fast pattern used throughout.

**Phase 1 — GitHub plumbing**
All read operations: fetch PRs, issues, comments, diff hunks, rate limit check, open PR detection by head branch pattern. Validate auth and data shapes against a real repo. No writes yet.

**Phase 2 — Structured logging**
Wire up the JSON logger (full UUID v4 `run_id`) early so every subsequent phase produces observable output from day one.

**Phase 3 — Plan generation**
Issue → plan → comment flow with size cap and retry enforcement. Read-only against the repo itself. Validates the AI integration at low risk.

**Phase 4 — Plan approval and issue selection**
Approval detection with content hash matching, queue iteration with skip-on-blocked logic, skiplist/allowlist filtering, oldest-first sort with deterministic tie-breaking, `agent:blocked` label handling.

**Phase 5 — Implementation loop**
Tool-use agent with filesystem tools against a cloned repo. Implement `write_file` directory creation, `read_file` similar-file fallback, all hard limits, rebase/conflict handling, and timeout behavior. Start with a trivial issue.

**Phase 6 — PR comment resolution**
Thread dedup marker, diff context fetching, PR FIX tool loop (shared implementer, lower cap), single-commit strategy.

**Phase 7 — Docker hardening**
Finalize base image, `--network none` default, log rotation, end-to-end container test, log volume wiring.

**Phase 8 — Operational features**
Dry-run mode, cost budget enforcement (`MAX_TOKENS_PER_RUN`), consecutive failure notifications, `agent:blocked` issue labeling on repeated failures.
