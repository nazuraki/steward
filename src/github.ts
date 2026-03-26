import { Octokit } from '@octokit/rest';
import { graphql } from '@octokit/graphql';
import type { PRSummary, IssueSummary, IssueComment, ReviewThread, ReviewComment, ReviewSummary } from './types.js';

interface GraphQLReviewThread {
  id: string;
  isResolved: boolean;
  comments: {
    nodes: Array<{
      databaseId: number;
      author: { login: string } | null;
      body: string;
      path: string;
      line: number | null;
      originalLine: number | null;
      diffHunk: string;
    }>;
  };
}

interface GraphQLReview {
  databaseId: number;
  author: { login: string } | null;
  body: string;
  state: string;
}

interface GraphQLPR {
  number: number;
  title: string;
  headRefName: string;
  updatedAt: string;
  reviewThreads: {
    nodes: GraphQLReviewThread[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
  reviews: {
    nodes: GraphQLReview[];
  };
}

export class GitHubClient {
  private rest: Octokit;
  private gql: typeof graphql;
  private owner: string;
  private repo: string;

  constructor(token: string, githubRepo: string) {
    const [owner, repo] = githubRepo.split('/');
    if (!owner || !repo) throw new Error(`Invalid GITHUB_REPO format: ${githubRepo}`);
    this.owner = owner;
    this.repo = repo;

    this.rest = new Octokit({ auth: token });
    this.gql = graphql.defaults({ headers: { authorization: `token ${token}` } });
  }

  // ── Validation helpers ──────────────────────────────────────────────────────

  async getTokenScopes(): Promise<string[]> {
    const res = await this.rest.repos.get({ owner: this.owner, repo: this.repo });
    const scopesHeader = (res.headers as Record<string, string>)['x-oauth-scopes'] ?? '';
    return scopesHeader.split(',').map(s => s.trim()).filter(Boolean);
  }

  async getRepoMetadata(): Promise<{ private: boolean; defaultBranch: string }> {
    const res = await this.rest.repos.get({ owner: this.owner, repo: this.repo });
    return { private: res.data.private, defaultBranch: res.data.default_branch };
  }

  // ── Rate limit ──────────────────────────────────────────────────────────────

  async getRateLimit(): Promise<{ remaining: number; limit: number; resetAt: Date }> {
    const res = await this.rest.rateLimit.get();
    const core = res.data.rate;
    return {
      remaining: core.remaining,
      limit: core.limit,
      resetAt: new Date(core.reset * 1000),
    };
  }

  // ── PR triage (Phase 1 read) ────────────────────────────────────────────────

  /**
   * Returns open PRs that have at least one unresolved review thread.
   * Uses GraphQL to get thread resolution status (not available via REST).
   */
  async getOpenPRsWithUnresolvedThreads(): Promise<PRSummary[]> {
    type GQLResult = {
      repository: {
        pullRequests: {
          nodes: GraphQLPR[];
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      };
    };

    const results: PRSummary[] = [];
    let cursor: string | null = null;

    do {
      const data: GQLResult = await this.gql<GQLResult>(
        `query GetPRs($owner: String!, $repo: String!, $cursor: String) {
          repository(owner: $owner, name: $repo) {
            pullRequests(states: [OPEN], first: 20, after: $cursor, orderBy: { field: UPDATED_AT, direction: ASC }) {
              nodes {
                number
                title
                headRefName
                updatedAt
                reviewThreads(first: 50) {
                  nodes {
                    id
                    isResolved
                    comments(first: 10) {
                      nodes {
                        databaseId
                        author { login }
                        body
                        path
                        line
                        originalLine
                        diffHunk
                      }
                    }
                  }
                  pageInfo { hasNextPage endCursor }
                }
                reviews(first: 20, states: [CHANGES_REQUESTED]) {
                  nodes {
                    databaseId
                    author { login }
                    body
                    state
                  }
                }
              }
              pageInfo { hasNextPage endCursor }
            }
          }
        }`,
        { owner: this.owner, repo: this.repo, cursor },
      );

      const prs: GQLResult['repository']['pullRequests'] = data.repository.pullRequests;

      for (const pr of prs.nodes) {
        const unresolvedThreads = pr.reviewThreads.nodes
          .filter((t: GraphQLReviewThread) => !t.isResolved)
          .map((t: GraphQLReviewThread): ReviewThread => {
            const firstComment = t.comments.nodes[0];
            return {
              id: t.id,
              isResolved: t.isResolved,
              path: firstComment?.path ?? '',
              diffHunk: firstComment?.diffHunk ?? '',
              line: firstComment?.line ?? firstComment?.originalLine ?? null,
              comments: t.comments.nodes.map((c: GraphQLReviewThread['comments']['nodes'][number]): ReviewComment => ({
                databaseId: c.databaseId,
                author: c.author?.login ?? 'unknown',
                body: c.body,
              })),
            };
          });

        const changeRequestedReviews: ReviewSummary[] = pr.reviews.nodes
          .filter((r: GraphQLReview) => r.state === 'CHANGES_REQUESTED' && r.body.trim())
          .map((r: GraphQLReview): ReviewSummary => ({
            databaseId: r.databaseId,
            author: r.author?.login ?? 'unknown',
            body: r.body,
          }));

        if (unresolvedThreads.length > 0 || changeRequestedReviews.length > 0) {
          results.push({
            number: pr.number,
            title: pr.title,
            headRef: pr.headRefName,
            updatedAt: pr.updatedAt,
            threads: unresolvedThreads,
            reviews: changeRequestedReviews,
          });
        }
      }

      cursor = prs.pageInfo.hasNextPage ? prs.pageInfo.endCursor : null;
    } while (cursor);

    // Sort: oldest-updated first, tie-break by lowest PR number
    return results.sort((a, b) => {
      const timeDiff = new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime();
      return timeDiff !== 0 ? timeDiff : a.number - b.number;
    });
  }

  /**
   * Returns full file content for a given path at the PR's head ref.
   */
  async getFileAtRef(path: string, ref: string): Promise<string> {
    try {
      const res = await this.rest.repos.getContent({
        owner: this.owner,
        repo: this.repo,
        path,
        ref,
      });
      if (Array.isArray(res.data) || res.data.type !== 'file') {
        throw new Error(`${path} is not a file`);
      }
      return Buffer.from(res.data.content, 'base64').toString('utf-8');
    } catch (e: unknown) {
      if (isOctokitError(e) && e.status === 404) return '';
      throw e;
    }
  }

  // ── Issue triage (Phase 1 read) ─────────────────────────────────────────────

  /**
   * Returns open issues (not PRs), with comments, sorted by priority then age.
   */
  async getOpenIssues(priorityLabels: string[]): Promise<IssueSummary[]> {
    const allIssues: IssueSummary[] = [];
    let page = 1;

    while (true) {
      const res = await this.rest.issues.listForRepo({
        owner: this.owner,
        repo: this.repo,
        state: 'open',
        per_page: 100,
        page,
      });

      if (res.data.length === 0) break;

      for (const issue of res.data) {
        // Skip pull requests (GitHub issues API returns PRs too)
        if (issue.pull_request) continue;

        const comments = await this.getIssueComments(issue.number);

        allIssues.push({
          number: issue.number,
          title: issue.title,
          body: issue.body ?? '',
          author: issue.user?.login ?? 'unknown',
          createdAt: issue.created_at,
          labels: issue.labels.map(l => (typeof l === 'string' ? l : l.name ?? '')),
          comments,
        });
      }

      if (res.data.length < 100) break;
      page++;
    }

    // Sort: priority tier first (lower index = higher priority), then oldest-created, tie-break by number
    return allIssues.sort((a, b) => {
      const tierDiff = priorityTier(a.labels, priorityLabels) - priorityTier(b.labels, priorityLabels);
      if (tierDiff !== 0) return tierDiff;
      const timeDiff = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      return timeDiff !== 0 ? timeDiff : a.number - b.number;
    });
  }

  async getIssueComments(issueNumber: number): Promise<IssueComment[]> {
    const res = await this.rest.issues.listComments({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
      per_page: 100,
    });
    return res.data.map(c => ({
      databaseId: c.id,
      author: c.user?.login ?? 'unknown',
      body: c.body ?? '',
      createdAt: c.created_at,
    }));
  }

  /**
   * Returns true if any open PR has a head branch matching agent/issue-{N}-*
   */
  async hasOpenAgentPR(issueNumber: number): Promise<boolean> {
    const pattern = `agent/issue-${issueNumber}-`;
    let page = 1;

    while (true) {
      const res = await this.rest.pulls.list({
        owner: this.owner,
        repo: this.repo,
        state: 'open',
        per_page: 100,
        page,
      });

      if (res.data.length === 0) break;

      for (const pr of res.data) {
        if (pr.head.ref.startsWith(pattern)) return true;
      }

      if (res.data.length < 100) break;
      page++;
    }

    return false;
  }

  // ── Write operations (stubs — implemented in later phases) ──────────────────

  async postIssueComment(issueNumber: number, body: string): Promise<number> {
    const res = await this.rest.issues.createComment({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
      body,
    });
    return res.data.id;
  }

  async updateComment(commentId: number, body: string): Promise<void> {
    await this.rest.issues.updateComment({
      owner: this.owner,
      repo: this.repo,
      comment_id: commentId,
      body,
    });
  }

  async addLabel(issueNumber: number, label: string): Promise<void> {
    await this.rest.issues.addLabels({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
      labels: [label],
    });
  }

  async removeLabel(issueNumber: number, label: string): Promise<void> {
    try {
      await this.rest.issues.removeLabel({
        owner: this.owner,
        repo: this.repo,
        issue_number: issueNumber,
        name: label,
      });
    } catch (e: unknown) {
      // 404 = label wasn't on the issue; safe to ignore
      if (!isOctokitError(e) || e.status !== 404) throw e;
    }
  }

  async getDefaultBranchSha(): Promise<string> {
    const meta = await this.getRepoMetadata();
    const res = await this.rest.git.getRef({
      owner: this.owner,
      repo: this.repo,
      ref: `heads/${meta.defaultBranch}`,
    });
    return res.data.object.sha;
  }

  async createBranch(branchName: string, sha: string): Promise<void> {
    await this.rest.git.createRef({
      owner: this.owner,
      repo: this.repo,
      ref: `refs/heads/${branchName}`,
      sha,
    });
  }

  async openPR(opts: {
    title: string;
    body: string;
    head: string;
    base: string;
  }): Promise<number> {
    const meta = await this.getRepoMetadata();
    const res = await this.rest.pulls.create({
      owner: this.owner,
      repo: this.repo,
      title: opts.title,
      body: opts.body,
      head: opts.head,
      base: opts.base ?? meta.defaultBranch,
    });
    return res.data.number;
  }

  async requestReview(prNumber: number, reviewers: string[]): Promise<void> {
    if (reviewers.length === 0) return;
    await this.rest.pulls.requestReviewers({
      owner: this.owner,
      repo: this.repo,
      pull_number: prNumber,
      reviewers,
    });
  }

  async getPRFiles(prNumber: number): Promise<Array<{ filename: string; status: string; patch?: string }>> {
    const res = await this.rest.pulls.listFiles({
      owner: this.owner,
      repo: this.repo,
      pull_number: prNumber,
      per_page: 100,
    });
    return res.data.map(f => ({ filename: f.filename, status: f.status, patch: f.patch }));
  }

  async createIssue(title: string, body: string, labels: string[]): Promise<number> {
    const res = await this.rest.issues.create({
      owner: this.owner,
      repo: this.repo,
      title,
      body,
      labels,
    });
    return res.data.number;
  }

  async closeIssue(issueNumber: number): Promise<void> {
    await this.rest.issues.update({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
      state: 'closed',
    });
  }

  async findOpenIssueByLabel(label: string): Promise<number | null> {
    const res = await this.rest.issues.listForRepo({
      owner: this.owner,
      repo: this.repo,
      state: 'open',
      labels: label,
      per_page: 1,
    });
    // Filter out PRs
    const issue = res.data.find(i => !i.pull_request);
    return issue ? issue.number : null;
  }
}

function priorityTier(labels: string[], priorityLabels: string[]): number {
  let nonePosition = priorityLabels.length; // default: unlabeled sorts after all tiers
  for (let i = 0; i < priorityLabels.length; i++) {
    const entry = priorityLabels[i];
    if (entry === '<none>' || entry === '<missing>') {
      nonePosition = i;
      continue;
    }
    if (labels.includes(entry)) return i;
  }
  return nonePosition;
}

function isOctokitError(e: unknown): e is { status: number } {
  return typeof e === 'object' && e !== null && 'status' in e;
}
