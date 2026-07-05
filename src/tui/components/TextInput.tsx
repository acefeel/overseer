import { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';

export interface TextInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: (value: string) => void;
  placeholder?: string;
  password?: boolean;
  focus?: boolean;
  width?: number;
}

export function TextInput({
  value,
  onChange,
  onSubmit,
  placeholder,
  password,
  focus = true,
  width = 60,
}: TextInputProps) {
  const [cursor, setCursor] = useState(value.length);

  useEffect(() => {
    setCursor((c) => Math.min(c, value.length));
  }, [value]);

  useInput(
    (input, key) => {
      if (key.return) {
        onSubmit?.(value);
        return;
      }
      if (key.leftArrow) {
        setCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (key.rightArrow) {
        setCursor((c) => Math.min(value.length, c + 1));
        return;
      }
      if (key.backspace || key.delete) {
        if (value.length === 0) return;
        const idx = key.delete ? cursor : cursor - 1;
        if (idx < 0) return;
        const next = value.slice(0, idx) + value.slice(idx + 1);
        onChange(next);
        if (!key.delete) setCursor(Math.max(0, cursor - 1));
        return;
      }
      if (input && !key.ctrl && !key.meta && input.length === 1) {
        const next = value.slice(0, cursor) + input + value.slice(cursor);
        onChange(next);
        setCursor(cursor + 1);
      }
    },
    { isActive: focus }
  );

  const display = password ? '*'.repeat(value.length) : value;
  const before = display.slice(0, cursor);
  const at = display[cursor] ?? ' ';
  const after = display.slice(cursor + 1);
  const showPlaceholder = value.length === 0 && placeholder;

  return (
    <Box>
      {showPlaceholder ? (
        <Text dimColor>{placeholder.padEnd(width)}</Text>
      ) : (
        <Text>
          {before}
          <Text backgroundColor={focus ? 'cyan' : 'gray'} color="black">
            {at}
          </Text>
          {after}
        </Text>
      )}
    </Box>
  );
}
