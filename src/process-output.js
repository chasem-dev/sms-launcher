'use strict';

const { execFileSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const { cleanOutputLine, failureReason } = require('./progress');

const WINDOWS_STATUSES = new Map([
  [0xC0000005, 'access violation'],
  [0xC0000017, 'out of memory'],
  [0xC000001D, 'illegal instruction'],
  [0xC0000094, 'integer division by zero'],
  [0xC00000FD, 'stack overflow'],
  [0xC0000135, 'DLL not found'],
  [0xC0000139, 'DLL entry point not found'],
  [0xC0000142, 'DLL initialization failed'],
  [0xC0000374, 'heap corruption'],
  [0xC0000409, 'fast-fail'],
  [0xC0000602, 'fail-fast exception']
]);

// Windows programs print in UTF-8 (MSYS2's tools, addr2line) or in the
// system's ANSI code page (the game's paths, which come from getenv), and the
// game's crash report has both. A line that isn't UTF-8 is read in the code
// page, so a Windows user name in Cyrillic shows as Иван, not as ����.
const CODE_PAGE_LABELS = new Map([[932, 'shift_jis'], [936, 'gbk'], [949, 'euc-kr'], [950, 'big5']]);

function codePageDecoder(page) {
  if (!Number.isInteger(page) || page <= 0 || page === 65001) return null;
  try { return new TextDecoder(CODE_PAGE_LABELS.get(page) || `windows-${page}`); } catch { return null; }
}

// Looked up the first time a line isn't UTF-8, which is rare.
let windowsDecoder;
function windowsCodePage(platform = process.platform) {
  if (windowsDecoder !== undefined) return windowsDecoder;
  windowsDecoder = null;
  if (platform !== 'win32') return null;
  try {
    const reg = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
    const out = execFileSync(reg, ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage', '/v', 'ACP'],
      { encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    windowsDecoder = codePageDecoder(Number(/\bACP\s+REG_SZ\s+(\d+)/i.exec(out)?.[1]));
  } catch {}
  return windowsDecoder;
}

// A partial line keeps an incomplete UTF-8 character back until the rest of it arrives.
function decodeLine(bytes, fallback, partial = false) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: partial });
  } catch {
    const decoder = fallback();
    return decoder ? decoder.decode(bytes) : Buffer.from(bytes).toString('utf8');
  }
}

// Complete lines, each decoded on its own, with their line endings.
function decodeLines(bytes, fallback) {
  let text = '', start = 0;
  for (let i = 0; i < bytes.length; ++i) {
    if (bytes[i] !== 0x0A && bytes[i] !== 0x0D) continue;
    if (i > start) text += decodeLine(bytes.subarray(start, i), fallback);
    text += bytes[i] === 0x0A ? '\n' : '\r';
    start = i + 1;
  }
  return text;
}

// Each pipe keeps its own undecoded bytes and partial line. Show partial output
// as it arrives, then update that entry instead of duplicating it at the next chunk.
// codePage: the decoder for lines that aren't UTF-8 (default: Windows' ANSI code page).
function observeProcess(child, { output, line = () => {}, capture = false, codePage } = {}) {
  const fallback = () => (codePage !== undefined ? codePage : windowsCodePage());
  return new Promise(resolve => {
    const readers = [];
    const captured = { stdout: '', stderr: '' };
    let error = null;
    for (const stream of ['stdout', 'stderr']) {
      let rest = Buffer.alloc(0), pending = '', entry = null, afterCR = false;
      function publish(text = pending) {
        text = cleanOutputLine(text);
        if (!entry || entry.text !== text) entry = output(text, stream, entry);
      }
      function consume(text) {
        if (capture) captured[stream] += text;
        let start = 0;
        for (let i = 0; i < text.length; ++i) {
          const character = text[i];
          if (afterCR && character === '\n') { afterCR = false; start = i + 1; continue; }
          afterCR = false;
          if (character !== '\r' && character !== '\n') continue;
          pending += text.slice(start, i);
          publish();
          line(cleanOutputLine(pending), stream, entry);
          pending = ''; entry = null;
          afterCR = character === '\r';
          start = i + 1;
        }
        pending += text.slice(start);
        if (pending) publish();
      }
      // Line endings are single bytes in UTF-8 and in every ANSI code page.
      function receive(bytes) {
        rest = rest.length ? Buffer.concat([rest, bytes]) : bytes;
        const end = Math.max(rest.lastIndexOf(0x0A), rest.lastIndexOf(0x0D)) + 1;
        if (end) {
          consume(decodeLines(rest.subarray(0, end), fallback));
          rest = rest.subarray(end);
        }
        if (rest.length) {
          const partial = decodeLine(rest, fallback, true);
          if (partial) publish(partial);
        }
      }
      child[stream].on('data', receive);
      readers.push(() => {
        if (rest.length) consume(decodeLine(rest, fallback));
        rest = Buffer.alloc(0);
        if (pending) line(cleanOutputLine(pending), stream, entry);
      });
    }
    child.on('error', value => { error = value; });
    child.on('close', (code, signal) => {
      for (const end of readers) end();
      resolve({ code, signal, error, ...captured });
    });
  });
}

function exitDescription(label, code, signal, platform = process.platform) {
  if (signal) return `${label} terminated by ${signal}`;
  const status = Number.isInteger(code) ? code >>> 0 : 0;
  const native = platform === 'win32' && status >= 0x80000000;
  const detail = native ? ` (0x${status.toString(16).toUpperCase().padStart(8, '0')}${WINDOWS_STATUSES.has(status) ? `: ${WINDOWS_STATUSES.get(status)}` : ''})` : '';
  return `${label} exited with code ${code}${detail}`;
}

// The signals Linux and macOS number alike, for naming another platform's than
// this computer's (whose own table, os.constants.signals, Windows numbers its own way).
const POSIX_SIGNALS = {
  SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5, SIGABRT: 6, SIGFPE: 8, SIGKILL: 9, SIGSEGV: 11,
  SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15,
};

// What a game exit code means when it isn't the game's own: on Windows, 3 is
// abort() (the C runtime's exit code for it, after the game's crash report);
// elsewhere a shell that ran the game reports a signal as 128 + its number.
function gameExitCause(code, platform = process.platform) {
  if (!Number.isInteger(code)) return '';
  if (platform === 'win32') return code === 3 ? 'abort: the game stopped itself after an error' : '';
  if (code <= 128 || code >= 160) return '';
  const signals = platform === process.platform ? os.constants.signals : POSIX_SIGNALS;
  const name = Object.keys(signals).find(key => signals[key] === code - 128);
  return name ? `${name}: the game crashed` : '';
}

function failureMessage(label, result, recent, { game = false, platform = process.platform } = {}) {
  const native = platform === 'win32' && Number.isInteger(result.code) && (result.code >>> 0) >= 0x80000000;
  // Game reports contain ordinary warnings and stage state. They do not tell
  // us what caused an abrupt exit, so quote only the actual process status.
  const reason = game || result.signal || native ? '' : failureReason(recent);
  const cause = game && !result.signal && !native ? gameExitCause(result.code, platform) : '';
  if (cause) {
    return `${exitDescription(label, result.code, result.signal, platform)} (${cause}). ` +
      'The activity log has its crash report: Copy log there to add it to a bug report.';
  }
  return `${exitDescription(label, result.code, result.signal, platform)}${reason ? `: ${reason}` : ''}. See the activity log.`;
}

module.exports = { observeProcess, exitDescription, failureMessage, codePageDecoder };
