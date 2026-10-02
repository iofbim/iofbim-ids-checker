/**
 * XSD regex → the dialects that run it (JavaScript in the browser, RE2 in DuckDB).
 *
 * The one XSD feature neither engine has is character-class subtraction:
 *   [\p{L}\p{N}\p{P}\s-[_]]   letters, digits, punctuation and spaces, but not "_"
 * A subtracted class is turned into the exact list of code-point ranges it stands for;
 * everything else is passed through unchanged. Results are cached per class.
 */

type ClassNode = { base: string; sub?: ClassNode; end: number };

/** Reads the class opening at `i` ("["), with an optional "-[…]" subtraction before its "]" */
function readClass(s: string, i: number): ClassNode | null {
  let j = i + 1;
  if (s[j] === '^') j++;
  if (s[j] === ']') j++; // a leading "]" is literal
  for (; j < s.length; j++) {
    const c = s[j];
    if (c === '\\') { j++; continue; }
    if (c === '-' && s[j + 1] === '[') {
      const sub = readClass(s, j + 1);
      if (!sub || s[sub.end + 1] !== ']') return null;
      return { base: s.slice(i + 1, j), sub, end: sub.end + 1 };
    }
    if (c === '[') return null;
    if (c === ']') return { base: s.slice(i + 1, j), end: j };
  }
  return null;
}

/** Whether a code point is in the class: in its base and not in its subtraction */
function member(node: ClassNode): (ch: string) => boolean {
  const base = new RegExp(`^[${node.base}]$`, 'u');
  const sub = node.sub ? member(node.sub) : null;
  return (ch) => base.test(ch) && !(sub && sub(ch));
}

/** The class as inclusive code-point ranges */
function ranges(node: ClassNode): [number, number][] {
  const inClass = member(node);
  const out: [number, number][] = [];
  let start = -1;
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    // Lone surrogates are not characters
    const hit = (cp < 0xd800 || cp > 0xdfff) && inClass(String.fromCodePoint(cp));
    if (hit && start < 0) start = cp;
    else if (!hit && start >= 0) { out.push([start, cp - 1]); start = -1; }
  }
  if (start >= 0) out.push([start, 0x10ffff]);
  return out;
}

const cache = new Map<string, [number, number][] | null>();

function rewrite(pattern: string, fmt: (cp: number) => string, empty: string): string {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\') { out += pattern.slice(i, i + 2); i++; continue; }
    if (c !== '[') { out += c; continue; }
    const node = readClass(pattern, i);
    if (!node) { out += c; continue; }
    const src = pattern.slice(i, node.end + 1);
    if (!node.sub) { out += src; i = node.end; continue; }
    if (!cache.has(src)) {
      try { cache.set(src, ranges(node)); } catch { cache.set(src, null); }
    }
    const r = cache.get(src);
    // A class JavaScript can't read is left as written: the engine will say so
    out += r ? (r.length ? `[${r.map(([a, b]) => (a === b ? fmt(a) : `${fmt(a)}-${fmt(b)}`)).join('')}]` : empty) : src;
    i = node.end;
  }
  return out;
}

const hex = (cp: number) => cp.toString(16).toUpperCase();

/** Whether the pattern uses XSD class subtraction */
export const hasClassSubtraction = (pattern: string): boolean => rewrite(pattern, () => '', '') !== pattern;

/** The pattern for a JavaScript RegExp with the "u" flag */
export const xsdToJs = (pattern: string): string => rewrite(pattern, (cp) => `\\u{${hex(cp)}}`, '[^\\s\\S]');

/** The pattern for RE2 (DuckDB regexp_* functions) */
export const xsdToRe2 = (pattern: string): string => rewrite(pattern, (cp) => `\\x{${hex(cp)}}`, '[^\\x{0}-\\x{10FFFF}]');
