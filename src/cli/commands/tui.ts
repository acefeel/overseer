import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function runTui(): Promise<void> {
  // dist/cli/commands/tui.js  →  上 3 级到项目根
  // src/cli/commands/tui.ts   →  上 3 级到项目根
  const isDev = __dirname.includes(path.sep + 'src' + path.sep);
  const projectRoot = path.resolve(__dirname, '..', '..', '..');

  const cmd = process.execPath;
  const args = isDev
    ? [path.join(projectRoot, 'node_modules', '.bin', 'tsx'),
       path.join(projectRoot, 'src', 'tui', 'index.tsx')]
    : [path.join(projectRoot, 'dist', 'tui', 'index.js')];

  const child = spawn(cmd, args, {
    cwd: projectRoot,
    stdio: 'inherit',
    shell: false,
    env: process.env,
  });

  await new Promise<void>((resolve) => {
    child.on('close', () => resolve());
    child.on('error', () => resolve());
  });
}
