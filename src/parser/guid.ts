/**
 * IFC GlobalId canonicalization.
 *
 * An IFC GlobalId is a 22-character compressed encoding of a 128-bit GUID,
 * using buildingSMART's custom base-64 alphabet (NOT standard base64):
 *
 *   0-9  A-Z  a-z  _  $        (indices 0..63)
 *
 * The 128 bits are split into one leading 2-bit group plus 21 6-bit groups
 * (2 + 21*6 = 128). The decode produces the canonical hyphenated GUID string
 * `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` (lowercase).
 *
 * Some tools also store the expanded GUID form directly; `canonicalizeGlobalId`
 * accepts either form and normalises to the lowercase hyphenated GUID.
 *
 * Reference: buildingSMART "IfcGloballyUniqueId" / IfcOpenShell guid module.
 */

const B64 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';

const B64_INDEX: Record<string, number> = (() => {
  const m: Record<string, number> = {};
  for (let i = 0; i < B64.length; i++) m[B64[i]!] = i;
  return m;
})();

const EXPANDED_GUID_RE =
  /^\{?([0-9a-fA-F]{8})-?([0-9a-fA-F]{4})-?([0-9a-fA-F]{4})-?([0-9a-fA-F]{4})-?([0-9a-fA-F]{12})\}?$/;

/**
 * Decode a 22-character IFC compressed GlobalId into a lowercase hyphenated
 * GUID. Returns null if the input is not a valid 22-char IFC GlobalId.
 */
export function decodeCompressedGuid(compressed: string): string | null {
  if (compressed.length !== 22) return null;

  // Decode each char to its 6-bit value (the first char carries only 2 bits).
  // Accumulate the full 128-bit number into 16 bytes.
  const bytes = new Uint8Array(16);
  let bitBuffer = 0;
  let bitCount = 0;
  let byteIndex = 0;

  for (let i = 0; i < 22; i++) {
    const ch = compressed[i]!;
    const val = B64_INDEX[ch];
    if (val === undefined) return null;
    // First char contributes 2 bits, the rest 6 bits each → 2 + 21*6 = 128.
    const bits = i === 0 ? 2 : 6;
    bitBuffer = (bitBuffer << bits) | (val & ((1 << bits) - 1));
    bitCount += bits;
    while (bitCount >= 8) {
      bitCount -= 8;
      if (byteIndex < 16) bytes[byteIndex++] = (bitBuffer >>> bitCount) & 0xff;
    }
  }
  if (byteIndex !== 16) return null;

  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  return (
    hex.slice(0, 8) + '-' +
    hex.slice(8, 12) + '-' +
    hex.slice(12, 16) + '-' +
    hex.slice(16, 20) + '-' +
    hex.slice(20, 32)
  );
}

/**
 * Encode a hyphenated/unhyphenated GUID hex string into the 22-character IFC
 * compressed form. Inverse of {@link decodeCompressedGuid}. Returns null on
 * malformed input. Exposed mainly for round-trip testing.
 */
export function encodeCompressedGuid(guid: string): string | null {
  const m = EXPANDED_GUID_RE.exec(guid.trim());
  if (!m) return null;
  const hex = (m[1]! + m[2]! + m[3]! + m[4]! + m[5]!).toLowerCase();
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);

  // Re-pack 128 bits as 2 + 21*6. Read bits MSB-first.
  let out = '';
  let bitBuffer = 0;
  let bitCount = 0;
  let groupIndex = 0;
  for (let i = 0; i < 16; i++) {
    bitBuffer = (bitBuffer << 8) | bytes[i]!;
    bitCount += 8;
    while (true) {
      const take = groupIndex === 0 ? 2 : 6;
      if (bitCount < take) break;
      bitCount -= take;
      const val = (bitBuffer >>> bitCount) & ((1 << take) - 1);
      out += B64[val]!;
      groupIndex++;
      if (groupIndex === 22) break;
    }
    if (groupIndex === 22) break;
  }
  return out.length === 22 ? out : null;
}

/**
 * Normalise an IFC GlobalId (either 22-char compressed or an expanded GUID
 * string) to the canonical lowercase hyphenated GUID. Returns null for
 * null/empty input or an unrecognised format.
 *
 * This is the matching key for federation/diff — two entities in any loaded
 * model with the same canonical GlobalId are the same real-world thing.
 */
export function canonicalizeGlobalId(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const s = raw.trim();
  if (s === '') return null;

  // Already an expanded GUID? Normalise case/format.
  const m = EXPANDED_GUID_RE.exec(s);
  if (m) {
    return (m[1]! + '-' + m[2]! + '-' + m[3]! + '-' + m[4]! + '-' + m[5]!).toLowerCase();
  }

  // Otherwise expect the 22-char compressed IFC form.
  return decodeCompressedGuid(s);
}
