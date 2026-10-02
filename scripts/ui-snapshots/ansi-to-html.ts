/**
 * A small ANSI-to-HTML converter for terminal screenshots: SGR colour (16, 256 and
 * truecolour), bold, dim, italic, underline, strikethrough and inverse. Other escape
 * sequences are dropped. No dependencies, so it runs anywhere the repo does.
 */

const ANSI16 = [
  '#000000',
  '#cc0000',
  '#00aa00',
  '#aa5500',
  '#0000cc',
  '#aa00aa',
  '#00aaaa',
  '#aaaaaa',
  '#555555',
  '#ff5555',
  '#55ff55',
  '#ffff55',
  '#5555ff',
  '#ff55ff',
  '#55ffff',
  '#ffffff',
];

const color256 = (n: number): string => {
  if (n < 16) return ANSI16[n];
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `rgb(${v},${v},${v})`;
  }
  const index = n - 16;
  const level = (x: number) => (x ? 55 + x * 40 : 0);
  return `rgb(${level(Math.floor(index / 36))},${level(Math.floor((index % 36) / 6))},${level(index % 6)})`;
};

interface Style {
  fg: string | null;
  bg: string | null;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  inverse: boolean;
}

const BLANK: Style = {
  fg: null,
  bg: null,
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  strike: false,
  inverse: false,
};

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function css(style: Style): string {
  let { fg, bg } = style;
  if (style.inverse) [fg, bg] = [bg ?? 'var(--bg)', fg ?? 'var(--fg)'];
  const rules: string[] = [];
  if (fg) rules.push(`color:${fg}`);
  if (bg) rules.push(`background:${bg}`);
  if (style.bold) rules.push('font-weight:bold');
  if (style.dim) rules.push('opacity:.6');
  if (style.italic) rules.push('font-style:italic');
  const decoration = [style.underline && 'underline', style.strike && 'line-through'].filter(Boolean).join(' ');
  if (decoration) rules.push(`text-decoration:${decoration}`);
  return rules.join(';');
}

function applySgr(style: Style, codes: number[]): Style {
  const next = { ...style };
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    if (code === 0) Object.assign(next, BLANK);
    else if (code === 1) next.bold = true;
    else if (code === 2) next.dim = true;
    else if (code === 3) next.italic = true;
    else if (code === 4) next.underline = true;
    else if (code === 7) next.inverse = true;
    else if (code === 9) next.strike = true;
    else if (code === 22) {
      next.bold = false;
      next.dim = false;
    } else if (code === 23) next.italic = false;
    else if (code === 24) next.underline = false;
    else if (code === 27) next.inverse = false;
    else if (code === 29) next.strike = false;
    else if (code >= 30 && code <= 37) next.fg = ANSI16[code - 30];
    else if (code >= 90 && code <= 97) next.fg = ANSI16[code - 90 + 8];
    else if (code >= 40 && code <= 47) next.bg = ANSI16[code - 40];
    else if (code >= 100 && code <= 107) next.bg = ANSI16[code - 100 + 8];
    else if (code === 39) next.fg = null;
    else if (code === 49) next.bg = null;
    else if (code === 38 || code === 48) {
      const key = code === 38 ? 'fg' : 'bg';
      if (codes[i + 1] === 2) {
        next[key] = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`;
        i += 4;
      } else if (codes[i + 1] === 5) {
        next[key] = color256(codes[i + 2]);
        i += 2;
      }
    }
  }
  return next;
}

/** The converted markup only (no `<pre>` wrapper). */
export function ansiToHtml(input: string): string {
  let style = BLANK;
  let out = '';
  // CSI colour sequences, any other CSI/private sequence (dropped), or plain text.
  const tokens = /\u001b\[([0-9;]*)m|\u001b\[[?0-9;]*[A-Za-z]|([^\u001b]+)/g;
  let match: RegExpExecArray | null;
  while ((match = tokens.exec(input))) {
    if (match[2] !== undefined) {
      const rules = css(style);
      out += rules ? `<span style="${rules}">${escapeHtml(match[2])}</span>` : escapeHtml(match[2]);
    } else if (match[1] !== undefined) {
      style = applySgr(style, match[1] === '' ? [0] : match[1].split(';').map(Number));
    }
  }
  return out;
}

export interface TerminalPalette {
  bg: string;
  fg: string;
}

export const TERMINAL_BACKGROUNDS: Record<'dark' | 'light', TerminalPalette> = {
  dark: { bg: '#0d1117', fg: '#e6edf3' },
  light: { bg: '#ffffff', fg: '#1f2328' },
};

/** A self-contained HTML page showing `ansi` as a terminal `columns` wide. */
export function ansiToHtmlPage(ansi: string, columns: number, background: 'dark' | 'light'): string {
  const { bg, fg } = TERMINAL_BACKGROUNDS[background];
  return `<!doctype html><meta charset="utf-8"><style>
:root{--bg:${bg};--fg:${fg}}
body{margin:0;background:${bg}}
pre{margin:0;padding:12px 14px;color:${fg};font:14px/1.25 'DejaVu Sans Mono','Menlo','Consolas',monospace;width:${columns}ch;box-sizing:content-box;white-space:pre}
</style><pre>${ansiToHtml(ansi)}</pre>`;
}
