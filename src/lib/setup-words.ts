// How setup talks about people and steps in a sentence, the same on the page and on a call. Pure.

/** The first word of the name someone gave, when it reads like a name. */
export function firstName(name: string | null | undefined): string | null {
  const first = (name ?? "").trim().split(/\s+/)[0] ?? "";
  return /^\p{L}[\p{L}'’-]{0,29}$/u.test(first) ? `${first.charAt(0).toUpperCase()}${first.slice(1)}` : null;
}

/** A checklist step as said mid-sentence: its name, without the detail after a colon or dash. */
export function stepName(text: string): string {
  const name = text.split(/:|\s[—–-]\s/)[0].trim().replace(/[.!?]+$/, "");
  // "Your search" reads as "your search"; "LinkedIn contacts" keeps its capital.
  const word = name.split(/\s/)[0];
  return /^\p{Lu}[^\p{Lu}]*$/u.test(word) ? `${name.charAt(0).toLowerCase()}${name.slice(1)}` : name;
}
