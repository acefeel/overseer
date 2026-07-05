import { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { TextInput } from './TextInput.js';

interface NoteHit {
  note: {
    slug: string;
    relativePath: string;
    frontmatter: Record<string, unknown>;
  };
  score: number;
  snippet: string;
}

interface VaultPanelProps {
  ipc: { request: (op: string, payload?: unknown, timeoutMs?: number) => Promise<unknown> };
  onClose: () => void;
  onNotify: (msg: string) => void;
}

export function VaultPanel({ ipc, onClose, onNotify }: VaultPanelProps) {
  const [mode, setMode] = useState<'recent' | 'search'>('recent');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<NoteHit[]>([]);
  const [selected, setSelected] = useState(0);
  const [focusInput, setFocusInput] = useState(false);

  const search = async (q: string) => {
    if (!q.trim()) return;
    try {
      const hits = (await ipc.request('kb.search', { q: q.trim(), limit: 20 })) as NoteHit[];
      setResults(hits);
      setSelected(0);
    } catch (e) {
      onNotify(`search failed: ${(e as Error).message}`);
    }
  };

  const recent = async () => {
    try {
      const notes = (await ipc.request('kb.recent', { limit: 20 })) as NoteHit['note'][];
      setResults(notes.map((n) => ({ note: n, score: 0, snippet: '' })));
      setSelected(0);
    } catch (e) {
      onNotify(`recent failed: ${(e as Error).message}`);
    }
  };

  useEffect(() => {
    recent();
  }, []);

  useInput((input, key) => {
    if (key.escape || input === 'q') {
      onClose();
      return;
    }
    if (key.tab) {
      setMode((m) => (m === 'recent' ? 'search' : 'recent'));
      if (mode === 'search') recent();
      setFocusInput(mode === 'recent');
      return;
    }
    if (mode === 'search' && focusInput) return; // let TextInput handle
    if (key.upArrow) {
      setSelected((s) => (s <= 0 ? results.length - 1 : s - 1));
    } else if (key.downArrow) {
      setSelected((s) => (s >= results.length - 1 ? 0 : s + 1));
    } else if (input === 'r') {
      if (mode === 'recent') recent();
      else search(query);
    }
  });

  return (
    <Box flexDirection="column" padding={1} borderStyle="round" borderColor="cyan" height={22}>
      <Box>
        <Text bold color="cyan">Vault</Text>
        <Text dimColor>  Tab 切换 · ↑↓ 浏览 · r 刷新 · Esc 返回</Text>
      </Box>
      <Box marginTop={1}>
        <Text color={mode === 'recent' ? 'cyan' : 'gray'} bold={mode === 'recent'}>[最近]</Text>
        <Text>  </Text>
        <Text color={mode === 'search' ? 'cyan' : 'gray'} bold={mode === 'search'}>[搜索]</Text>
      </Box>
      {mode === 'search' && (
        <Box marginTop={1}>
          <TextInput
            value={query}
            onChange={setQuery}
            onSubmit={(v) => {
              setFocusInput(false);
              search(v);
            }}
            placeholder="输入搜索词…"
            focus={focusInput}
            width={60}
          />
        </Box>
      )}
      <Box flexDirection="column" marginTop={1}>
        {results.length === 0 ? (
          <Text dimColor>无结果</Text>
        ) : (
          results.map((hit, idx) => {
            const active = idx === selected;
            const fm = hit.note.frontmatter || {};
            return (
              <Box key={hit.note.relativePath} flexDirection="column" marginBottom={1}>
                <Text color={active ? 'cyan' : 'white'} bold={active}>
                  {active ? '> ' : '  '}
                  {fm.type ? `[${fm.type}] ` : ''}
                  {hit.note.slug}
                  {hit.score > 0 ? ` · score ${hit.score}` : ''}
                </Text>
                <Text dimColor>  {hit.note.relativePath}</Text>
                {hit.snippet && <Text>  {hit.snippet.slice(0, 120)}</Text>}
              </Box>
            );
          })
        )}
      </Box>
    </Box>
  );
}
