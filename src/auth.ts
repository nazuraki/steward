import { createAppAuth } from '@octokit/auth-app';

/**
 * Resolves the effective GitHub token for this run from one of three sources
 * (checked in priority order):
 *
 * 1. GitHub App credentials — produces a short-lived installation token (1hr).
 *    Requires: GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_APP_INSTALLATION_ID
 *
 * 2. Plain token — a PAT or the Actions-injected GITHUB_TOKEN.
 *    Requires: GITHUB_TOKEN
 *
 * App tokens expire in 1hr. Since MAX_RUNTIME_SECONDS defaults to 600s (10min),
 * a single token minted at startup covers the full run with plenty of headroom.
 * No mid-run refresh is needed.
 */
export async function resolveGitHubToken(): Promise<string> {
  const appId = process.env.GITHUB_APP_ID;
  const privateKeyRaw = process.env.GITHUB_APP_PRIVATE_KEY;
  const installationId = process.env.GITHUB_APP_INSTALLATION_ID;

  if (appId && privateKeyRaw && installationId) {
    // Env vars commonly store PEM newlines as the literal two-character sequence \n.
    // Normalize to real newlines so the PEM parser accepts the key.
    const privateKey = privateKeyRaw.replace(/\\n/g, '\n');

    const auth = createAppAuth({
      appId,
      privateKey,
      installationId: parseInt(installationId, 10),
    });

    const result = await auth({ type: 'installation' });
    return result.token;
  }

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error(
      'GitHub authentication not configured. Set one of:\n' +
        '  Option A (PAT / Actions token): GITHUB_TOKEN\n' +
        '  Option B (GitHub App):          GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY + GITHUB_APP_INSTALLATION_ID',
    );
  }
  return token;
}
