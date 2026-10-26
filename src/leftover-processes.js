'use strict';

const { execFile } = require('node:child_process');
const path = require('node:path');

// addr2line.exe started by the game's Windows crash reporter and still running
// after the game. Game builds before pc-port#269 never stopped it and let it
// inherit every handle the game had. Holding the game's output pipes, it kept
// the game "running" in the launcher after it had closed, and Stop found no
// game left to end. Holding the disc, it kept an old game version from being
// deleted. One is found by name, and then either as the game's child or as
// reading a game in one of the launcher's game folders (the -e argument), which
// also finds those left by earlier crashes. Every other process is left alone.
//
// The folders come in SMS_LEFTOVER_ROOTS, separated by |, which no Windows path
// contains. In the environment, a path needs no quoting for PowerShell.
const WINDOWS_QUERY = [
  '$parent = [int]$env:SMS_LEFTOVER_PARENT',
  "$roots = @($env:SMS_LEFTOVER_ROOTS -split '\\|' | Where-Object { $_ } | ForEach-Object { $_.Replace('/', '\\').TrimEnd('\\') + '\\' })",
  "Get-CimInstance Win32_Process -Filter \"Name LIKE '%addr2line.exe'\" | Where-Object { " +
    "$line = ([string]$_.CommandLine).Replace('/', '\\'); " +
    '($parent -and $_.ParentProcessId -eq $parent) -or ' +
    '@($roots | Where-Object { $line.IndexOf($_, [StringComparison]::OrdinalIgnoreCase) -ge 0 }).Count ' +
  '} | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop; $_.ProcessId } catch {} }'
].join('; ');

// A drive's root would match every addr2line on the drive.
function gameFolders(roots) {
  const folders = [];
  for (const root of roots) {
    if (!root) continue;
    const folder = path.win32.resolve(root);
    if (path.win32.parse(folder).root.toLowerCase() === folder.toLowerCase()) continue;
    if (!folders.some(other => other.toLowerCase() === folder.toLowerCase())) folders.push(folder);
  }
  return folders;
}

function windowsCommand({ parent = 0, roots = [] } = {}, environment = process.env) {
  return { command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_QUERY],
    env: { ...environment, SMS_LEFTOVER_PARENT: String(parent || 0), SMS_LEFTOVER_ROOTS: gameFolders(roots).join('|') } };
}

// The process IDs it ended. Never throws: on failure nothing is ended.
function stopLeftoverAddr2line(options, { run = execFile, platform = process.platform } = {}) {
  if (platform !== 'win32') return Promise.resolve([]);
  const { command, args, env } = windowsCommand(options);
  if (!options.parent && !env.SMS_LEFTOVER_ROOTS) return Promise.resolve([]);
  return new Promise(resolve => run(command, args, { env, windowsHide: true, timeout: 15000 }, (_error, stdout) =>
    resolve(String(stdout || '').split(/\r?\n/).map(value => Number(value.trim())).filter(id => Number.isInteger(id) && id > 0))));
}

module.exports = { WINDOWS_QUERY, gameFolders, windowsCommand, stopLeftoverAddr2line };
