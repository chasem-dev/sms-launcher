'use strict';

const { execFileSync } = require('node:child_process');
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
// A program the child started can hold its pipes open after it ends, as the game's
// crash reporter's addr2line did: settleAfterExit is how long, in milliseconds, to
// wait for the rest of the output once the child exits. Then lingering() is told,
// the pipes are closed, and the child counts as finished.
function observeProcess(child, { output, line = () => {}, capture = false, codePage, settleAfterExit, lingering } = {}) {
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
    let finished = false, settling = null;
    function finish(code, signal) {
      if (finished) return;
      finished = true;
      clearTimeout(settling);
      for (const end of readers) end();
      resolve({ code, signal, error, ...captured });
    }
    child.on('close', finish);
    if (settleAfterExit !== undefined) child.on('exit', (code, signal) => {
      settling = setTimeout(() => {
        lingering?.();
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(code, signal);
      }, settleAfterExit);
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

function failureMessage(label, result, recent, { game = false, platform = process.platform } = {}) {
  const native = platform === 'win32' && Number.isInteger(result.code) && (result.code >>> 0) >= 0x80000000;
  // Game reports contain ordinary warnings and stage state. They do not tell
  // us what caused an abrupt exit, so quote only the actual process status.
  const reason = game || result.signal || native ? '' : failureReason(recent);
  return `${exitDescription(label, result.code, result.signal, platform)}${reason ? `: ${reason}` : ''}. See the activity log.`;
}

module.exports = { observeProcess, exitDescription, failureMessage, codePageDecoder };
