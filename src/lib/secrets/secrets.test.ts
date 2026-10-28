import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { maskSecrets } from "@/lib/agent/tools/sanitize";
import { cardBrand, cardDigits, cardExpiry, luhn, maskCardNumbers } from "./card";
import { seal, unseal } from "./index";

const KEY = randomBytes(32);
const ADA = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";

describe("sealing a saved login or card", () => {
  it("opens only with the same key, for the same person and kind", () => {
    const sealed = seal(KEY, ADA, "login", { password: "hunter2" });
    expect(sealed).not.toContain("hunter2");
    expect(unseal(KEY, ADA, "login", sealed)).toEqual({ password: "hunter2" });
    expect(unseal(KEY, BOB, "login", sealed)).toBeNull();
    expect(unseal(KEY, ADA, "card", sealed)).toBeNull();
    expect(unseal(randomBytes(32), ADA, "login", sealed)).toBeNull();
  });
  it("keeps a card's security code sealed with the rest of it", () => {
    const card = { number: "4242424242424242", name: "Ada", expMonth: "04", expYear: "27", code: "123" };
    const sealed = seal(KEY, ADA, "card", card);
    expect(sealed).not.toContain("123");
    expect(unseal(KEY, ADA, "card", sealed)).toEqual(card);
  });

  it("refuses anything tampered with", () => {
    const [v, iv, tag, body] = seal(KEY, ADA, "card", { number: "4242424242424242", name: "Ada", expMonth: "04", expYear: "27" }).split(".");
    const flipped = Buffer.from(body, "base64url");
    flipped[0] ^= 1;
    expect(unseal(KEY, ADA, "card", [v, iv, tag, flipped.toString("base64url")].join("."))).toBeNull();
    expect(unseal(KEY, ADA, "card", "not sealed")).toBeNull();
  });
});

describe("card numbers", () => {
  it("are checked, named, and read the way people type them", () => {
    expect(luhn("4242424242424242")).toBe(true);
    expect(luhn("4242424242424241")).toBe(false);
    expect(cardDigits("4242 4242 4242 4242")).toBe("4242424242424242");
    expect(cardDigits("4242-4242-4242-4241")).toBeNull();
    expect(cardBrand("4242424242424242")).toBe("Visa");
    expect(cardBrand("5555555555554444")).toBe("Mastercard");
    expect(cardBrand("378282246310005")).toBe("Amex");
    expect(cardExpiry("4/27")).toEqual({ month: "04", year: "27" });
    expect(cardExpiry("12 / 2030")).toEqual({ month: "12", year: "30" });
    expect(cardExpiry("13/27")).toBeNull();
  });
  it("are masked to their last four in free text, and nothing else is", () => {
    expect(maskCardNumbers("Card 4242 4242 4242 4242 saved")).toBe("Card •••• 4242 saved");
    expect(maskCardNumbers("Order 1234567890123, call 4155551234")).toBe("Order 1234567890123, call 4155551234");
    expect(maskSecrets('{"value":"5555-5555-5555-4444"}')).toBe('{"value":"•••• 4444"}');
  });
});
