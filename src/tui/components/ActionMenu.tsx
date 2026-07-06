import { Box, Text, useInput } from 'ink';

export interface MenuItem {
  key: string;
  label: string;
  desc?: string;
}

export interface ActionMenuProps {
  items: MenuItem[];
  selected: number;
  /** 仅在选择项上下移动时触发，不跳转页面 */
  onChange: (index: number) => void;
  /** 用户按 Enter 确认当前选择时触发 */
  onSelect: (index: number) => void;
  onClose: () => void;
}

export function ActionMenu({ items, selected, onChange, onSelect, onClose }: ActionMenuProps) {
  useInput((input, key) => {
    if (key.escape || input === 'q') {
      onClose();
      return;
    }
    if (key.upArrow) {
      onChange(selected <= 0 ? items.length - 1 : selected - 1);
      return;
    }
    if (key.downArrow) {
      onChange(selected >= items.length - 1 ? 0 : selected + 1);
      return;
    }
    if (key.return) {
      onSelect(selected);
    }
  });

  return (
    <Box flexDirection="column" padding={1} borderStyle="round" borderColor="cyan">
      <Text bold color="cyan">操作菜单</Text>
      <Text dimColor>↑↓ 选择 · Enter 确认 · Esc/q 关闭</Text>
      {items.map((item, idx) => {
        const active = idx === selected;
        return (
          <Box key={item.key} marginTop={1}>
            <Text color={active ? 'cyan' : 'gray'} bold={active}>
              {active ? '> ' : '  '}
              {item.label.padEnd(14)}
            </Text>
            <Text dimColor>{item.desc}</Text>
          </Box>
        );
      })}
    </Box>
  );
}
