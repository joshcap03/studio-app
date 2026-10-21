// Card numbers: checking one a member typed, naming its brand, and finding one in free text so it
// can be masked. Pure, so the server, the page, and tests share it.

/** Whether a string of digits passes the Luhn check every card number does. */
export function luhn(digits: string): boolean {
  if (!/^[0-9]{12,19}$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/** The digits of a card number as typed (spaces and dashes allowed), or null if it isn't one. */
export function cardDigits(typed: string): string | null {
  const digits = typed.replace(/[\s-]/g, "");
  return /^[0-9]{13,19}$/.test(digits) && luhn(digits) ? digits : null;
}

export function cardBrand(digits: string): string {
  if (/^4/.test(digits)) return "Visa";
  if (/^(5[1-5]|2[2-7])/.test(digits)) return "Mastercard";
  if (/^3[47]/.test(digits)) return "Amex";
  if (/^(6011|65|64[4-9])/.test(digits)) return "Discover";
  return "Card";
}

/** A card's expiry as typed ("4/27", "04 / 2027") as month and two-digit year, if it's a real one. */
export function cardExpiry(typed: string): { month: string; year: string } | null {
  const m = /^\s*(0?[1-9]|1[0-2])\s*[/-]\s*(?:20)?([0-9]{2})\s*$/.exec(typed);
  return m ? { month: m[1].padStart(2, "0"), year: m[2] } : null;
}

/** 13–19 digits, possibly in groups split by spaces or dashes, as a card number is written. */
const CARD_LIKE = /\b[0-9](?:[ -]?[0-9]){12,18}\b/g;

/** Free text with anything that's really a card number (it passes Luhn) masked to its last four. */
export function maskCardNumbers(text: string): string {
  return text.replace(CARD_LIKE, (found) => {
    const digits = found.replace(/[ -]/g, "");
    return luhn(digits) ? `•••• ${digits.slice(-4)}` : found;
  });
}
