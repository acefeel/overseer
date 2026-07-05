import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { TextInput } from './TextInput.js';

interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  text: string;
  meta?: string;
}

export interface ChatPanelProps {
  ipc: { request: (op: string, payload?: unknown, timeoutMs?: number) => Promise<unknown> };
  onClose: () => void;
  mode?: string;
}

export function ChatPanel({ ipc, onClose, mode }: ChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([
    { role: 'system', text: `当前模式: ${mode ?? 'unknown'}。输入消息回车发送，Esc 返回。` },
  ]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);

  useInput((_inputKey, key) => {
    if (key.escape) onClose();
  });

  const send = async () => {
    const text = input.trim();
    if (!text || sending) return;
    setMessages((m) => [...m, { role: 'user', text }]);
    setInput('');
    setSending(true);
    try {
      const res = (await ipc.request('chat', { text }, 120_000)) as any;
      const metaParts: string[] = [];
      if (res.provider && res.provider !== '-') metaParts.push(`${res.provider}/${res.model}`);
      if (res.retrievedNotes) metaParts.push(`📖${res.retrievedNotes}`);
      if (res.memoryWritten) metaParts.push(`📝${res.memoryWritten.type}`);
      setMessages((m) => [
        ...m,
        { role: 'assistant', text: res.reply, meta: metaParts.join(' · ') },
      ]);
    } catch (e) {
      setMessages((m) => [...m, { role: 'system', text: `发送失败: ${(e as Error).message}` }]);
    } finally {
      setSending(false);
    }
  };

  return (
    <Box flexDirection="column" padding={1} borderStyle="round" borderColor="cyan" height={22}>
      <Text bold color="cyan">Chat</Text>
      <Box flexDirection="column" flexGrow={1} marginY={1}>
        {messages.map((m, idx) => (
          <Box key={idx} flexDirection="column" marginBottom={1}>
            <Text
              color={m.role === 'user' ? 'green' : m.role === 'assistant' ? 'white' : 'gray'}
              bold={m.role === 'user'}
            >
              {m.role === 'user' ? 'you: ' : m.role === 'assistant' ? 'overSeer: ' : 'sys: '}
            </Text>
            <Text>{m.text}</Text>
            {m.meta && <Text dimColor>{m.meta}</Text>}
          </Box>
        ))}
      </Box>
      <Box>
        <Text color="cyan">{'> '}</Text>
        <TextInput value={input} onChange={setInput} onSubmit={send} width={60} focus={!sending} />
        {sending && <Text color="yellow"> 发送中…</Text>}
      </Box>
    </Box>
  );
}
