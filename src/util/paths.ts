import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..', '..');

export const PATHS = {
  ROOT,
  SRC: path.join(ROOT, 'src'),
  DIST: path.join(ROOT, 'dist'),
  CONFIG_DIR: path.join(ROOT, 'config'),
  MAIN_CONFIG: path.join(ROOT, 'config', 'overseer.config.yaml'),
  LOCAL_CONFIG: path.join(ROOT, 'config', 'overseer.config.local.yaml'),
  SECRETS: path.join(ROOT, 'config', '.secrets.yaml'),
  DATA_DIR: path.join(ROOT, 'data'),
  LOG_DIR: path.join(ROOT, 'logs'),
  LOG_FILE: path.join(ROOT, 'logs', 'overseer.log'),
  TOKEN_LEDGER: path.join(ROOT, 'data', 'token-ledger.jsonl'),
  METRICS_LEDGER: path.join(ROOT, 'data', 'provider-metrics.jsonl'),
  STATE_FILE: path.join(ROOT, 'data', 'state.json'),
  PID_FILE: path.join(ROOT, 'data', 'daemon.pid'),
  VAULT_ROOT: path.join(ROOT, 'vault'),
} as const;

export function resolveWorkspaceRoot(relativeRoot: string | undefined): string {
  if (!relativeRoot) return path.dirname(ROOT);
  return path.resolve(ROOT, relativeRoot);
}

export function ensureDataDirs(): void {
  for (const p of [PATHS.DATA_DIR, PATHS.LOG_DIR]) {
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  }
}
