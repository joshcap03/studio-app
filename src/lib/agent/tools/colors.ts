/**
 * The plain name of a color given as a hex code, so a card can say "#fb4c2f (red)" where a tool's
 * arguments carry only the code: what the member reads is the word, never the code alone.
 * Six-digit hex only (what Gmail, Calendar, Sheets and most apps use); anything else is left as is.
 */
const HEX = /^#?([0-9a-f]{6})$/i;

export function colorName(value: string): string | null {
  const m = HEX.exec(value.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d < 0.08) return l > 0.9 ? "white" : l < 0.12 ? "black" : "gray";
  const s = d / (1 - Math.abs(2 * l - 1));
  if (s < 0.15) return "gray";
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  if (h < 15 || h >= 345) return l > 0.75 ? "pink" : "red";
  if (h < 42) return l > 0.75 ? "peach" : "orange";
  if (h < 68) return "yellow";
  if (h < 160) return "green";
  if (h < 200) return "teal";
  if (h < 255) return "blue";
  if (h < 300) return "purple";
  return "pink";
}

/** `value` with its color name after it when it's a hex code, else unchanged. */
export function withColorName(value: string): string {
  const name = colorName(value);
  return name ? `${value} (${name})` : value;
}
