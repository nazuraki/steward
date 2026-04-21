# Purpose

Steward is a GitHub agent that automates the issue-to-PR lifecycle using Claude as its reasoning engine.

## What it does

Given a backlog of labeled GitHub issues, steward:

1. **Triages** — selects the highest-priority open issue not already in progress
2. **Plans** — writes a concrete implementation plan as a GitHub comment, asking for approval
3. **Implements** — clones the repo, applies the changes using Claude's tool-use loop, and opens a pull request
4. **Reviews** — monitors open PRs for review comments and pushes fix commits in response

Each step runs on a schedule (typically cron). Steward is stateless between runs — all state lives in GitHub (issue labels, PR comments, commit history).

## What it is not

- Not a general-purpose coding assistant — it operates on a defined issue queue, not ad-hoc prompts
- Not event-driven — it polls on a schedule rather than reacting to webhooks
- Not autonomous — the plan step requires a human to approve before implementation begins

## Design principles

**Pull-based over push-based.** No webhooks to maintain or inbound ports to expose. A cron job is the only infrastructure required.

**GitHub as the state machine.** Labels, comments, and PR status are the source of truth. Steward can be restarted at any point without losing progress.

**Bounded autonomy.** Configurable limits on tool iterations, file writes, runtime, and command output prevent runaway behavior. Consecutive failures halt the agent automatically.

**Identity-aware.** Steward tracks its own bot username so it can skip its own comments, avoid re-reviewing its own PRs, and attribute commits correctly.
