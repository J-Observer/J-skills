import { execFile as nativeExecFile, execFileSync as nativeExecFileSync, spawnSync as nativeSpawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, isAbsolute } from 'node:path';
import { promisify } from 'node:util';

// Keep npm shims and browser JavaScript out of cmd.exe. Other commands retain
// Node's normal child_process behavior, including caller-provided test binaries.
export function resolveCommand(command, args, options = {}) {
  const env = { ...process.env, ...options.env };
  if (command === 'opencli' && env.OPENCLI_BIN) command = env.OPENCLI_BIN;
  if (process.platform !== 'win32' || !(command === 'opencli' || command === env.OPENCLI_BIN || /opencli/i.test(basename(command)))) {
    return [command, args];
  }
  if (isAbsolute(command) && /\.exe$/i.test(command)) return [command, args];
  if (isAbsolute(command) && existsSync(command)) {
    const header = readFileSync(command, 'utf8').slice(0, 160);
    if (/\.[cm]?js$/i.test(command) || /^#![^\n]*\bnode\b/.test(header)) return [process.execPath, [command, ...args]];
  }
  const roots = isAbsolute(command) ? [dirname(command)] : [env.APPDATA ? join(env.APPDATA, 'npm') : null].filter(Boolean);
  for (const root of roots) {
    const entry = join(root, 'node_modules', '@jackwener', 'opencli', 'dist', 'src', 'main.js');
    if (existsSync(entry)) return [process.execPath, [entry, ...args]];
  }
  throw new Error('OpenCLI Windows entry not found. Check the existing global installation or OPENCLI_BIN.');
}

export function execFileSync(command, args, options = {}) {
  const [executable, argv] = resolveCommand(command, args, options);
  return nativeExecFileSync(executable, argv, options);
}

export function spawnSync(command, args, options = {}) {
  try {
    const [executable, argv] = resolveCommand(command, args, options);
    return nativeSpawnSync(executable, argv, options);
  } catch (error) {
    return { error, status: null, signal: null, stdout: null, stderr: null, pid: 0, output: [null, null, null] };
  }
}

export function execFile(command, args, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  const [executable, argv] = resolveCommand(command, args, options ?? {});
  return nativeExecFile(executable, argv, options ?? {}, callback);
}

execFile[promisify.custom] = (command, args, options = {}) => {
  const [executable, argv] = resolveCommand(command, args, options);
  return promisify(nativeExecFile)(executable, argv, options);
};
