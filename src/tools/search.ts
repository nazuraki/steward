import { execFileSync } from 'child_process';

const MAX_LINES = 200;

export function searchCode(
  workDir: string,
  pattern: string,
  opts: { regex?: boolean; path?: string } = {},
): string {
  const args: string[] = [
    '--line-number',
    '--with-filename',
    '--color=never',
    '--max-count=50',
  ];

  if (!opts.regex) args.push('--fixed-strings');
  if (opts.path) args.push('--glob', opts.path);

  args.push(pattern);

  try {
    const output = execFileSync('rg', args, {
      cwd: workDir,
      encoding: 'utf-8',
      timeout: 30_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const lines = output.trim().split('\n').filter(Boolean);
    if (lines.length === 0) return '(no matches)';
    if (lines.length > MAX_LINES) {
      return (
        lines.slice(0, MAX_LINES).join('\n') +
        `\n\n[... ${lines.length - MAX_LINES} more lines omitted ...]`
      );
    }
    return lines.join('\n');
  } catch (e: unknown) {
    // rg exits 1 when no matches found — not an error
    if (isExitError(e) && e.status === 1) return '(no matches)';
    return `Search error: ${e}`;
  }
}

interface ExitError { status: number | null }
function isExitError(e: unknown): e is ExitError {
  return typeof e === 'object' && e !== null && 'status' in e;
}
