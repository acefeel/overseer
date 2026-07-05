import React from 'react';
import { render } from 'ink';
import { pathToFileURL } from 'node:url';
import { App } from './App.js';

export function startTui(): void {
  render(React.createElement(App));
}

// 直接 `node dist/tui/index.js` 时自动启动
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  startTui();
}
