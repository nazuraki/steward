import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs';
import { resolve, dirname, relative, join } from 'path';

function safeResolve(workDir: string, filePath: string): string | null {
  const root = resolve(workDir);
  const abs = resolve(workDir, filePath);
  // Must be within workDir (allow the root itself for list_directory)
  if (abs !== root && !abs.startsWith(root + '/')) return null;
  return abs;
}

export function readFile(workDir: string, filePath: string): string {
  const abs = safeResolve(workDir, filePath);
  if (!abs) return 'Error: path traversal not allowed';

  if (!existsSync(abs)) {
    const similar = findSimilar(workDir, filePath);
    const hint = similar.length > 0
      ? `\nDid you mean:\n${similar.map(f => `  ${f}`).join('\n')}`
      : '';
    return `Error: file not found: ${filePath}${hint}`;
  }

  try {
    return readFileSync(abs, 'utf-8');
  } catch (e) {
    return `Error reading file: ${e}`;
  }
}

export function writeFile(workDir: string, filePath: string, content: string): string {
  const abs = safeResolve(workDir, filePath);
  if (!abs) return 'Error: path traversal not allowed';

  try {
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf-8');
    return `Wrote ${filePath} (${content.split('\n').length} lines)`;
  } catch (e) {
    return `Error writing file: ${e}`;
  }
}

export function listDirectory(workDir: string, dirPath: string = '.'): string {
  const abs = safeResolve(workDir, dirPath);
  if (!abs) return 'Error: path traversal not allowed';
  if (!existsSync(abs)) return `Error: not found: ${dirPath}`;

  try {
    const entries = readdirSync(abs, { withFileTypes: true });
    if (entries.length === 0) return '(empty)';
    return entries
      .map(e => (e.isDirectory() ? `${e.name}/` : e.name))
      .join('\n');
  } catch (e) {
    return `Error: ${e}`;
  }
}

function findSimilar(workDir: string, targetPath: string): string[] {
  const needle = (targetPath.split('/').pop() ?? '').split('.')[0].toLowerCase();
  if (!needle) return [];

  const results: string[] = [];

  function walk(dir: string, depth: number): void {
    if (depth > 6 || results.length >= 5) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        walk(full, depth + 1);
      } else if (e.name.toLowerCase().includes(needle)) {
        results.push(relative(workDir, full));
      }
    }
  }

  walk(workDir, 0);
  return results;
}
