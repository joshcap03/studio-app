// What goes between two parts of one reply that arrive joined end to end: the text an agent wrote
// before a tool call and the text after it, or the reply before an approval and the rest of the
// run once the member decides ("…to you.You can keep…", "…okay to send?Sent it to Jo.").

const LINE_ENDING_MARKDOWN = /```$|\|$/;
// Han, kana, and CJK punctuation and full-width forms: no spaces between words or sentences.
const CJK = "\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\u3000-\\u303f\\uff00-\\uffef";
const ENDS_CJK = new RegExp(`[${CJK}]$`, "u");
const STARTS_CJK = new RegExp(`^[${CJK}]`, "u");

/**
 * Nothing when either side already has whitespace or the second part carries on the sentence
 * with punctuation; a space when it carries on with a word; else a paragraph break, since each
 * part is its own thought (a reply, then the line after its card).
 */
export function seamBetween(before: string, after: string): string {
  if (!before || !after || /\s$/.test(before) || /^\s/.test(after)) return "";
  if (/^[,.;:!?)\]}%'’”]/.test(after)) return "";
  // Markdown that ends a line (a code fence, a table row) needs a new one after it.
  if (LINE_ENDING_MARKDOWN.test(before)) return "\n\n";
  // A word in lowercase carries on the sentence, even after "[1]", ")" or "U.S.".
  if (/^\p{Ll}/u.test(after)) return " ";
  if (/[。！？]$/.test(before)) return "\n\n";
  if (ENDS_CJK.test(before) && STARTS_CJK.test(after)) return "";
  if (/[.!?:…)\]"”؟]$/.test(before) || /^[\p{Lu}\d#>*|`-]/u.test(after) || /^\p{Extended_Pictographic}/u.test(after)) return "\n\n";
  return " ";
}
