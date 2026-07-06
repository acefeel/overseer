import { z } from 'zod';
import fs from 'node:fs';
import { PATHS } from './paths.js';
import { parse as parseYaml } from 'yaml';

export const ProviderConfigSchema = z.object({
  enabled: z.boolean().default(true),
  kind: z.string(),
  baseUrl: z.string().url(),
  apiKey: z.string().default(''),
  model: z.string(),
  fallbackModels: z.array(z.string()).default([]),
  timeout: z.number().int().positive().default(120000),
  rpmLimit: z.number().int().positive().default(60),
  /**
   * 在系统中的角色：
   * - main（默认）：主控，可执行有副作用的动作
   * - fallback：降级回退或本地 worker。是否可执行副作用由 `canAct` 字段决定，
   *   不再在角色层强制禁止。
   */
  role: z.enum(['main', 'fallback']).default('main'),
});

export const BudgetConfigSchema = z.object({
  dailyLimitTokens: z.number().int().positive(),
  weeklyLimitTokens: z.number().int().positive(),
  safetyPadTokens: z.number().int().nonnegative(),
  perTaskEstimateCap: z.number().int().positive(),
  useQuotaApi: z.boolean().default(true),
  rollingWindowHours: z.number().int().positive().default(24),
  onLowBudget: z.array(z.string()).default(['log', 'pause', 'notify_cli']),
});

export const DaemonConfigSchema = z.object({
  supervisionIntervalMs: z.number().int().positive().default(600000),
  ipcName: z.string().default('overseer'),
  pidFile: z.string().default('data/daemon.pid'),
  maxIntentionsPerCycle: z.number().int().positive().default(3),
  autonomy: z.object({
    aggressiveness: z.enum(['light', 'normal', 'full']).default('normal'),
    limitPerScanner: z.number().int().positive().default(5),
    autoExecute: z.boolean().default(false),
    allowShellDuringScan: z.boolean().default(false),
    onlyProjects: z.array(z.string()).default([]),
  }).default({}),
  chat: z.object({
    confirmLevel: z.enum(['paranoid', 'normal', 'none']).default('normal'),
    allowActions: z.boolean().default(true),
  }).default({}),
});

export const ActionsConfigSchema = z.object({
  defaultMode: z.enum(['dry-run', 'live']).default('dry-run'),
  alwaysAllow: z.array(z.string()),
  requiresApproval: z.array(z.string()),
  writeAllowedProjects: z.array(z.string()).default([]),
});

export const VaultConfigSchema = z.object({
  root: z.string(),
  manageObsidianConfig: z.boolean().default(true),
  dailyDir: z.string(),
  decisionsDir: z.string(),
  budgetsDir: z.string(),
});

export const LoggingConfigSchema = z.object({
  level: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  pretty: z.boolean().default(true),
  file: z.string(),
});

export const AppConfigSchema = z.object({
  workspace: z.object({
    root: z.string().default('.'),
    watchProjects: z.array(z.string()).default([]),
    ignore: z.array(z.string()).default([]),
    /**
     * 当 workspace 未被显式设置（仍为默认值）时，CLI 启动是否交互提示用户选择工作目录。
     * 默认 true。可通过 `overseer workspace set` 持久化或 `--workspace` 参数避免提示。
     */
    promptIfUnset: z.boolean().default(true),
  }),
  vault: VaultConfigSchema,
  providers: z.record(z.string(), ProviderConfigSchema),
  router: z.object({
    chain: z.array(z.string()),
    /** 降级模式启用的 fallback provider id（必须 role: fallback） */
    fallback: z.string().optional(),
    taskRouting: z.record(z.string(), z.string()).default({}),
  }),
  budget: BudgetConfigSchema,
  daemon: DaemonConfigSchema,
  actions: ActionsConfigSchema,
  logging: LoggingConfigSchema,
});

export type AppConfig = z.infer<typeof AppConfigSchema>;
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type BudgetConfig = z.infer<typeof BudgetConfigSchema>;
export type ActionsConfig = z.infer<typeof ActionsConfigSchema>;

function loadYaml(file: string): Record<string, unknown> | null {
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, 'utf8');
  return (parseYaml(raw) as Record<string, unknown>) ?? null;
}

function readJsonSafe(file: string): Record<string, unknown> | null {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function deepMerge<T>(base: T, ...overrides: Partial<T>[]): T {
  const out: any = Array.isArray(base) ? [...(base as any)] : { ...(base as any) };
  for (const o of overrides) {
    if (!o) continue;
    for (const k of Object.keys(o) as (keyof T)[]) {
      const v = o[k];
      if (v === undefined) continue;
      const bv = (out as any)[k];
      if (v && typeof v === 'object' && !Array.isArray(v) && bv && typeof bv === 'object') {
        (out as any)[k] = deepMerge(bv, v as any);
      } else {
        (out as any)[k] = v;
      }
    }
  }
  return out as T;
}

function applyEnvSecrets(cfg: Record<string, any>): void {
  const providers = cfg.providers;
  if (!providers || typeof providers !== 'object') return;
  for (const id of Object.keys(providers)) {
    const envKey = `OVERSEER_${id.toUpperCase()}_API_KEY`;
    const envVal = process.env[envKey];
    if (envVal) {
      providers[id].apiKey = envVal;
    }
  }
}

let _cached: AppConfig | null = null;

export function loadConfig(opts: { force?: boolean } = {}): AppConfig {
  if (_cached && !opts.force) return _cached;
  const main = loadYaml(PATHS.MAIN_CONFIG) ?? {};
  const local = loadYaml(PATHS.LOCAL_CONFIG) ?? {};
  const secrets = loadYaml(PATHS.SECRETS) ?? {};
  const merged = deepMerge(main, local, secrets);
  applyEnvSecrets(merged);
  const parsed = AppConfigSchema.safeParse(merged);
  if (!parsed.success) {
    throw new Error(
      'config validation failed:\n' +
        JSON.stringify(parsed.error.flatten().fieldErrors, null, 2)
    );
  }
  _cached = parsed.data;
  return _cached;
}

export function readState(): Record<string, unknown> {
  return readJsonSafe(PATHS.STATE_FILE) ?? {};
}

export function writeState(state: Record<string, unknown>): void {
  fs.writeFileSync(PATHS.STATE_FILE, JSON.stringify(state, null, 2));
}

export function invalidateConfigCache(): void {
  _cached = null;
}

export function isProviderReady(id: string): boolean {
  const cfg = loadConfig();
  const p = cfg.providers[id];
  return !!p && p.enabled && !!p.apiKey && p.apiKey.length > 0;
}
