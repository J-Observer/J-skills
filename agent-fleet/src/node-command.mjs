import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

// Windows cannot execute a Node shebang. Keep explicit script launchers and
// their argument boundaries intact without routing through a command shell.
export function nodeCommand(command, args, platform = process.platform) {
  if (platform === 'win32' && isAbsolute(command) && !/\.exe$/i.test(command) && existsSync(command)) {
    if (/\.[cm]?js$/i.test(command) || /^#![^\n]*\bnode\b/.test(readFileSync(command, 'utf8').slice(0, 160))) {
      return [process.execPath, [command, ...args]];
    }
  }
  return [command, args];
}
