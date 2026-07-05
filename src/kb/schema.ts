import { z } from 'zod';

export const NoteType = z.enum([
  'moc',
  'daily',
  'adr',
  'budget',
  'plan',
  'design',
  'retro',
  'knowledge',
  'chat_log',
]);
export type NoteType = z.infer<typeof NoteType>;

export const NoteStatus = z.enum(['draft', 'active', 'done', 'abandoned', 'superseded']);
export type NoteStatus = z.infer<typeof NoteStatus>;

export const FrontmatterSchema = z.object({
  type: NoteType,
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  project: z.string().default('overSeer'),
  tags: z.array(z.string()).default([]),
  status: NoteStatus.default('active'),
  title: z.string().optional(),
  aliases: z.array(z.string()).optional(),
  supersededBy: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});
export type Frontmatter = z.infer<typeof FrontmatterSchema>;

export interface Note {
  path: string;
  relativePath: string;
  slug: string;
  frontmatter: Frontmatter | Record<string, unknown>;
  body: string;
  links: string[];
}

export const TYPE_TO_DIR: Record<NoteType, (project: string) => string> = {
  moc: () => '',
  daily: () => 'overSeer/daily',
  adr: () => 'overSeer/decisions',
  budget: () => 'overSeer/budgets',
  plan: (p) => `${p}/plans`,
  design: (p) => `${p}/designs`,
  retro: (p) => `${p}/retros`,
  knowledge: (p) => p,
  chat_log: () => 'overSeer/chat-logs',
};

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'untitled';
}

export function todayStr(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
