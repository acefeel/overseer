import { Box, Text } from 'ink';

export interface HelpProps {
  daemonAlive: boolean;
  lastAction?: string;
}

export function HelpBar({ daemonAlive, lastAction }: HelpProps) {
  return (
    <Box flexDirection="column">
      <Box>
        <Text dimColor>────────────────────────────────────────────────────────</Text>
      </Box>
      <Box>
        <Text dimColor>daemon: </Text>
        <Text color={daemonAlive ? 'green' : 'red'} bold={daemonAlive}>
          {daemonAlive ? 'running' : 'NOT running'}
        </Text>
        {lastAction && (
          <>
            <Text dimColor>   last: </Text>
            <Text color="yellow">{lastAction}</Text>
          </>
        )}
      </Box>
      <Box>
        <Text dimColor>
          [m]菜单 [y]cycle [w]queue [p]plan [a]审批 [c]chat [v]vault   [r]刷新 [d]重启daemon   [Space]恢复loop [x]暂停loop [q]退出 [Q]全退
        </Text>
      </Box>
    </Box>
  );
}
