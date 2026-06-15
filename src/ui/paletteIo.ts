/**
 * User palette import/export. Supports the common interchange formats so people
 * can bring swatch sets from Photoshop/Illustrator/GIMP/Coolors:
 *   • GIMP .gpl          ("GIMP Palette" header, "R G B  name" rows)
 *   • Adobe-ish .hex/.txt (one hex per line, with or without #)
 *   • .json              (array of hex strings, or {colors:[...]}, or Coolors)
 * Plus a localStorage-backed library so saved palettes persist across sessions.
 */

const HEX6 = /^#?[0-9a-fA-F]{6}$/;
const HEX3 = /^#?[0-9a-fA-F]{3}$/;

function normHex(s: string): string | null {
  const t = s.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{6}$/.test(t)) return '#' + t.toLowerCase();
  if (/^[0-9a-fA-F]{3}$/.test(t)) return '#' + t[0] + t[0] + t[1] + t[1] + t[2] + t[2];
  return null;
}

/** Parse palette text in whatever format we can recognise → list of #rrggbb. */
export function parsePaletteText(text: string, filename = ''): string[] {
  const out: string[] = [];
  const push = (h: string | null): void => {
    if (h && !out.includes(h)) out.push(h);
  };

  // JSON first (array, {colors}, or Coolors {colors:[{hex}]}).
  const trimmed = text.trim();
  if (filename.endsWith('.json') || trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const data = JSON.parse(trimmed);
      const arr: unknown[] = Array.isArray(data)
        ? data
        : Array.isArray((data as { colors?: unknown[] }).colors)
          ? (data as { colors: unknown[] }).colors
          : [];
      for (const item of arr) {
        if (typeof item === 'string') push(normHex(item));
        else if (item && typeof item === 'object' && 'hex' in item) push(normHex(String((item as { hex: unknown }).hex)));
      }
      if (out.length) return out;
    } catch {
      /* fall through to line parsing */
    }
  }

  // GIMP .gpl: "R G B  name" rows after a "GIMP Palette" header.
  if (/gimp palette/i.test(text) || filename.endsWith('.gpl')) {
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})/);
      if (m) {
        const [r, g, b] = [m[1], m[2], m[3]].map((n) => Math.min(255, parseInt(n, 10)));
        push('#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join(''));
      }
    }
    if (out.length) return out;
  }

  // Generic: pull every hex-looking token from the text.
  for (const token of text.split(/[\s,;]+/)) {
    if (HEX6.test(token) || HEX3.test(token)) push(normHex(token));
  }
  return out;
}

/** Serialize swatches to a portable .hex file body (one #rrggbb per line). */
export function serializePaletteHex(colors: string[]): string {
  return colors.map((c) => c.toLowerCase()).join('\n') + '\n';
}

// ---- localStorage-backed user palette library ----

const LS_KEY = 'tifo_palettes_v1';

export interface SavedPalette {
  id: string;
  name: string;
  colors: string[];
}

export function listSavedPalettes(): SavedPalette[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const data = JSON.parse(raw);
    return Array.isArray(data) ? (data as SavedPalette[]) : [];
  } catch {
    return [];
  }
}

export function saveUserPalette(name: string, colors: string[]): SavedPalette {
  const palettes = listSavedPalettes();
  const entry: SavedPalette = {
    id: `p${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
    name: name.trim() || 'My palette',
    colors: colors.map((c) => c.toLowerCase()),
  };
  palettes.unshift(entry);
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(palettes.slice(0, 50)));
  } catch {
    /* quota — ignore */
  }
  return entry;
}

export function deleteUserPalette(id: string): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(listSavedPalettes().filter((p) => p.id !== id)));
  } catch {
    /* ignore */
  }
}
