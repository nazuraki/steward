# steward

A GitHub agent that triages issues and pull request reviews, writing implementation plans, opening PRs, and addressing review comments on a schedule.

---

## Authentication

Steward needs a GitHub token to read and write to the target repo. Three options, from simplest to most capable:

---

### Option 1 — `GITHUB_TOKEN` (GitHub Actions only)

GitHub automatically injects `GITHUB_TOKEN` into every Actions run. Zero setup — just configure the workflow's permissions.

```yaml
# .github/workflows/steward.yml in the target repo
jobs:
  steward:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
      issues: write
    steps:
      - uses: actions/checkout@v4
      - run: npm ci && npm start
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          GITHUB_BOT_USERNAME: github-actions[bot]
          # ...
```

**Limitations:**
- Identity is always `github-actions[bot]` — not customizable
- Token is scoped to the repo the workflow runs in; can't drive a different repo
- Only works inside GitHub Actions (not for local runs or external schedulers)

---

### Option 2 — Fine-grained PAT

Create a dedicated GitHub account (e.g. `steward-bot`) and generate a fine-grained PAT from it. Works anywhere — local scripts, GitHub Actions, external schedulers.

**Required permissions** (set when creating the token, scoped to the target repo):

| Permission | Access |
|---|---|
| Contents | Read and Write |
| Issues | Read and Write |
| Pull requests | Read and Write |
| Metadata | Read (implicit) |

Set in your environment:

```
GITHUB_TOKEN=github_pat_...
GITHUB_BOT_USERNAME=steward-bot   # the account that owns the PAT
```

**Limitations:**
- Identity shows as the account username, no `[bot]` suffix
- Token doesn't expire automatically (set an expiry and rotate it)
- Requires a dedicated GitHub account if you want a clean bot identity

---

### Option 3 — GitHub App (recommended for production)

GitHub Apps are the only mechanism that produces a true `name[bot]` identity (e.g. `steward[bot]`). Tokens are short-lived (1hr), auto-scoped to the installation, and can be installed org-wide.

#### Setup

1. Go to **Settings → Developer settings → GitHub Apps → New GitHub App**
2. Set the name (e.g. `steward`) — this becomes the `steward[bot]` identity
3. Set **Homepage URL** to this repo's URL
4. Disable **Webhook** (steward is pull-based, not event-driven)
5. Set **Repository permissions:**
   - Contents: Read and Write
   - Issues: Read and Write
   - Pull requests: Read and Write
   - Metadata: Read-only (required)
6. Set **Where can this GitHub App be installed?** → "Only on this account" or "Any account"
7. Create the app, then **Generate a private key** — download the `.pem` file
8. Install the app on the target repo (or your org) and note the **Installation ID** from the URL:
   `github.com/settings/installations/{INSTALLATION_ID}`

#### Configuration

```
GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY=-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----
GITHUB_APP_INSTALLATION_ID=78901234
GITHUB_BOT_USERNAME=steward[bot]
```

> **Tip — storing the private key:** When setting `GITHUB_APP_PRIVATE_KEY` as an environment variable or Actions secret, replace each newline in the PEM file with the literal two characters `\n`. Steward normalizes these back automatically.
>
> ```bash
> # One-liner to convert a downloaded .pem to the env var format:
> cat steward.pem | awk '{printf "%s\\n", $0}' | pbcopy
> ```

If all three App vars are present, steward uses them and ignores `GITHUB_TOKEN`.

---

## Local development

Copy `.env.example` to `.env`, fill in your values, then:

```bash
npm run dev
```

`WORK_DIR` and `LOG_DIR` can be any local paths — steward creates them if they don't exist:

```
WORK_DIR=/tmp/steward-work
LOG_DIR=/tmp/steward-logs
```

Each run clones the target repo fresh into `WORK_DIR` and appends a JSON record to `$LOG_DIR/runs.jsonl`.

---

## Repo configuration

Steward reads `steward.json` (or `.steward.json` or `steward.config.json`) from the root of the target repo. All fields are optional — defaults apply for anything omitted.

```json
{
  "allowlist": ["user1", "user2"],
  "skiplist": ["dependabot[bot]", "github-actions[bot]"],
  "requireIssueAllowlist": true,
  "requiredLabels": ["bug", "enhancement", "feature", "documentation", "refactor", "chore"],
  "priorityLabels": ["priority", "<none>", "nice to have"],
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

Any key can be overridden by a corresponding environment variable — see `.env.example` for the full list.

### `requiredLabels`

Issues must have at least one of these labels to be considered. Issues without a matching label are silently skipped. Set to `[]` to disable the filter.

The label is also used to determine the conventional commit type for the PR title and commit message:

| Label(s) | Commit type |
|---|---|
| `bug`, `fix`, `bugfix`, `hotfix` | `fix` |
| `documentation`, `docs` | `docs` |
| `refactor` | `refactor` |
| `chore` | `chore` |
| `test`, `tests` | `test` |
| `perf`, `performance` | `perf` |
| `style` | `style` |
| anything else | `feat` |

### `priorityLabels`

Ordered list of priority labels. Issues are sorted by first matching label (index 0 = highest priority), then by age (oldest first), then by issue number.

Use `<none>` or `<missing>` as a sentinel to explicitly position unlabeled issues within the order rather than always appending them last:

```json
["priority", "<none>", "nice to have"]
```

This places unlabeled issues between `priority` and `nice to have` issues. Without the sentinel, unlabeled issues always sort after all labeled tiers.
