import * as fs from 'fs';
import * as path from 'path';
import {execSync} from 'child_process';

function commandExists(name: string): boolean {
  try {
    execSync(process.platform === 'win32' ? `where ${name}` : `which ${name}`, {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

export function findCodexPath(): string | null {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  const candidates: string[] = [];

  if (process.platform === 'win32') {
    for (const name of ['codex.cmd', 'codex.exe']) {
      candidates.push(
        path.join(homeDir, '.local', name),
        path.join(homeDir, '.local', 'bin', name),
        path.join(homeDir, '.local', 'node_modules', '.bin', name),
        path.join(homeDir, '.cargo', 'bin', name),
      );
    }
  } else {
    candidates.push(
      path.join(homeDir, '.local', 'bin', 'codex'),
      path.join(homeDir, '.local', 'node_modules', '.bin', 'codex'),
      path.join(homeDir, '.cargo', 'bin', 'codex'),
      '/usr/local/bin/codex',
      '/opt/homebrew/bin/codex',
    );
  }

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      continue;
    }
  }
  return commandExists('codex') ? 'codex' : null;
}
