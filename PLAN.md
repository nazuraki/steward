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
          → [ORCHESTRATOR] Post plan as issue comment with marker <!-- agent-plan:cid={comment_id} -->
          → Log task=plan, issue=#, exit
      → If issue has a plan but no matching approval: skip (continue to next issue)
      → If issue has an approved plan:
          → [ORCHESTRATOR] Create branch: agent/issue-{N}-{short-slug}
          → [ORCHESTRATOR] Fresh clone of repo into WORK_DIR
          → [ORCHESTRATOR] Fetch and rebase from main before starting
          → [AI: IMPLEMENT] Given plan + repo access via tool-use loop → implement solution
          → [ORCHESTRATOR] Rebase from main before push
          → If merge conflict: abort, delete branch, log task=implement_conflict, exit
          → [ORCHESTRATOR] Commit, push branch
          → [ORCHESTRATOR] Open PR (title from issue title; body from template — see PR Format)
          → Log task=implement, issue=#, pr=#, exit

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

PR FIX reuses the IMPLEMENT tool loop with a lower iteration cap. PLAN is a single-turn completion.

---

## Phase 0: Environment Validation

Runs before any GitHub or AI logic. Fails fast with a clear error rather than consuming a cron slot silently.

1. Verify `git` is installed and executable.
2. Verify `ANTHROPIC_API_KEY` is set and reachable (lightweight no-op prompt).
3. Verify `GITHUB_TOKEN` has write access to `GITHUB_REPO` (read repo metadata; check scopes header).
4. Verify required env vars are present (`GITHUB_REPO`, `GITHUB_BOT_USERNAME`, `WORK_DIR`, `LOG_DIR`).

Log `task=validation_failed, outcome=error` and exit non-zero if any check fails.

---

## AI Tool Set

The agent exposes these tools to the AI during the IMPLEMENT and PR FIX phases:

| Tool | Purpose |
|---|---|
| `read_file` | Read file contents by path |
| `write_file` | Write/overwrite a file (auto-creates parent directories) |
| `list_directory` | Browse repo structure |
| `run_command` | Run scoped shell commands (linters, test runners, build tools) |
| `search_code` | Search across the codebase |
| `get_issue_details` | Fetch the current work item's issue + comments |
| `post_comment` | Post a comment to the current work item's issue or PR |

**Tool scope:** `get_issue_details` and `post_comment` are scoped to the current work item only. The orchestrator injects the target issue/PR number at invocation time and the tool implementations enforce it — the AI cannot reach arbitrary issues or PRs.

**Context strategy:** Do not dump the full repo into the prompt. Feed the issue and plan, then let the AI pull in what it needs via `list_directory` and `read_file`. This keeps token usage bounded and mirrors how a developer actually explores a codebase.

### Tool Implementation Notes

**`write_file`:** Always perform the equivalent of `mkdir -p` on the target path before writing. Never fail on a missing parent directory.

**`read_file` (non-existent path):** Return an error that includes a short list of similarly-named files found via `search_code` logic. Allows the AI to self-correct on hallucinated paths without an extra round-trip.

**`search_code`:** Executes ripgrep (literal string match by default; regex mode available via a flag in the tool input). Results are truncated at a configurable line limit if the match set is large, with a note indicating truncation.

**`run_command` whitelist + isolation:** Commands are restricted to a configured whitelist (e.g. test runner, linter, build tool). Default Docker network mode is `none`. Set `ALLOW_NETWORK=true` to use bridge mode for repos that require network access during build/test (dep installs, etc.). Explicit opt-in, not the default.

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

All configuration via environment variables:

```
# Required
GITHUB_TOKEN=                        # needs repo scope; workflow scope if org repo
ANTHROPIC_API_KEY=
GITHUB_REPO=owner/repo

# Agent identity
GITHUB_BOT_USERNAME=                 # used to identify the bot's own comments
GIT_USER_NAME=                       # used for git commit author (e.g. "My Bot")
GIT_USER_EMAIL=                      # use GitHub noreply: ID+username@users.noreply.github.com

# Comment filtering
AGENT_COMMENT_ALLOWLIST=user1,user2  # if set, only these users can trigger work (issues + PR threads)
AGENT_COMMENT_SKIPLIST=dependabot[bot],github-actions[bot]
REQUIRE_ISSUE_ALLOWLIST=true         # set false for private repos to process issues from any user

# Safety limits
MAX_TOOL_ITERATIONS=25               # hard ceiling on AI tool-use loop (IMPLEMENT)
MAX_PR_FIX_ITERATIONS=10             # lower ceiling for PR FIX tool-use loop
MAX_PLAN_RETRIES=2                   # max retries if PLAN output exceeds size cap
MAX_RUNTIME_SECONDS=600              # hard wall-clock limit per run
MAX_COMMANDS=20                      # max run_command calls per run
MAX_FILE_WRITES=30                   # max write_file calls per run
CMD_OUTPUT_MAX_TOKENS=2000           # truncation threshold for run_command output

# GitHub rate limiting
RATE_LIMIT_THRESHOLD=100             # exit early if GitHub API remaining calls below this

# Issue priority
PRIORITY_LABEL=priority:high         # label that elevates an issue to top of queue

# Network isolation
ALLOW_NETWORK=false                  # set true for repos requiring network during build/test

# Runtime
WORK_DIR=/tmp/repo                   # fresh clone target each run; wiped at start of each run
LOG_DIR=/var/log/gh-agent            # mount a volume here to persist logs
```

---

## Structured Logging

Each run appends one JSON record to `$LOG_DIR/runs.jsonl`. Log rotation is handled in the Docker setup phase (size- or age-based; implementation TBD).

```json
{
  "run_id": "a3f2c1d4-7e6b-4c2a-9f1d-3b8e5a2c0d9f",
  "timestamp": "2026-03-14T12:00:00Z",
  "repo": "owner/repo",
  "task": "implement | plan | pr_review | awaiting_approval | idle | plan_failed | implement_conflict | validation_failed | error",
  "issue": 42,
  "pr": null,
  "duration_ms": 12400,
  "tokens": {
    "input": 18200,
    "output": 3100,
    "total": 21300
  },
  "outcome": "success | error | timeout",
  "error": null
}
```

`run_id` is a full UUID (v4) generated at startup, present on every log record. Allows correlation across multi-line output and crash traces. `issue` and `pr` are null when not applicable. Token counts are accumulated across all AI calls within a single run.

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

1. Agent posts plan comment with marker `<!-- agent-plan:cid={comment_id} -->` where `comment_id` is the GitHub REST API comment ID of the plan comment. Includes note: *"Reply with `agent: approved` to begin implementation."*
2. On subsequent runs, agent checks for an approval comment containing both `agent: approved` and the matching `cid` value, from a qualifying user (allowlist if configured, otherwise any non-skiplist human).
3. If the plan comment is edited (GitHub assigns a new comment ID on edit), the prior approval is invalidated and a new one is required.
4. If approved: proceed to implementation.
5. If not approved: skip and continue down the priority queue. Log `task=awaiting_approval` only if every candidate issue is in this state.

**Plan size cap:** PLAN output is rejected and retried (up to `MAX_PLAN_RETRIES`) with a stricter prompt if it exceeds 200 lines or 8,000 characters. On exhaustion, log `task=plan_failed` and exit. Oversized plans typically indicate the AI is including implementation detail that belongs in code, not the plan.

**Stale plans:** If an issue is edited after the plan is approved, the agent will implement from the original plan. This is by design — edits after approval require the human to delete the approval comment and re-approve the updated plan. Document this in the plan comment itself.

---

## Thread Dedup for PR Review

Before processing any review run, the orchestrator checks for an existing PR comment (posted by `GITHUB_BOT_USERNAME`) containing `agent-processed-threads` with a JSON list of already-handled thread IDs. Threads in this list are skipped even if still technically unresolved in GitHub's API.

After all fixes are applied and pushed, the orchestrator upserts this comment with the full updated list.

This prevents double-fixing if a run crashes after push but before logging, or if GitHub's resolved state lags.

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

`WORK_DIR` is wiped and re-cloned fresh at the start of every run. There is no reuse of prior clones. This avoids stale state from previous runs and ensures the agent always works from a clean checkout. The clone happens immediately before the IMPLEMENT phase, not at agent startup.

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
| Double-fixing PR threads | Thread IDs recorded in PR comment after each run; skipped on re-runs |
| Stale plan approval | Approval tied to plan comment ID; editing the plan invalidates prior approval |
| Stuck issue blocking the queue | Issue queue iterated; awaiting-approval issues skipped, not blocking |
| Old issues starved by new ones | Within priority tier, sort oldest-created first; tie-break by issue number |
| Oversized plan blowing IMPLEMENT context | Plan capped at 200 lines / 8k chars; retry up to `MAX_PLAN_RETRIES`; log `plan_failed` on exhaustion |
| Deleted branch re-triggering work | Existing-work detection queries open PRs by head branch pattern, not branch existence |
| Mid-run timeout leaving partial work | On timeout: push existing commits, post timeout comment with run ID, exit with `outcome=timeout` |
| Merge conflict during implementation | Rebase from main before push; on conflict abort, delete branch, log `implement_conflict` |
| AI tool accessing wrong issue/PR | `get_issue_details` and `post_comment` scoped to current work item; enforced at tool level |
| Stale plan implemented after issue edit | Documented behavior: humans must delete approval and re-approve after editing an issue |
| Untrusted users filing issues on public repos | `REQUIRE_ISSUE_ALLOWLIST=true` by default; gates issue triage to allowlist authors or explicit `agent: consider`; disable for private repos |
| GitHub comment ID API instability | Using REST API comment IDs, which have been stable; noted as an implementation assumption |

---

## Phased Build Order

**Phase 0 — Environment validation**
Startup checks: git, API key reachability, GitHub token scopes, required env vars. Sets the fail-fast pattern used throughout.

**Phase 1 — GitHub plumbing**
All read operations: fetch PRs, issues, comments, diff hunks, rate limit check, open PR detection by head branch pattern. Validate auth and data shapes against a real repo. No writes yet.

**Phase 2 — Structured logging**
Wire up the JSON logger (full UUID v4 `run_id`) early so every subsequent phase produces observable output from day one.

**Phase 3 — Plan generation**
Issue → plan → comment flow with size cap and retry enforcement. Read-only against the repo itself. Validates the AI integration at low risk.

**Phase 4 — Plan approval and issue selection**
Approval detection with comment ID matching, queue iteration with skip-on-blocked logic, skiplist/allowlist filtering, oldest-first sort with deterministic tie-breaking.

**Phase 5 — Implementation loop**
Tool-use agent with filesystem tools against a cloned repo. Implement `write_file` directory creation, `read_file` similar-file fallback, all hard limits, rebase/conflict handling, and timeout behavior. Start with a trivial issue.

**Phase 6 — PR comment resolution**
Thread dedup marker, diff context fetching, PR FIX tool loop (shared implementer, lower cap), single-commit strategy.

**Phase 7 — Docker hardening**
Finalize base image, `--network none` default, log rotation, end-to-end container test, log volume wiring.
