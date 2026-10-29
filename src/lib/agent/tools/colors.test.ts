import { describe, expect, it } from "vitest";
import { colorName, withColorName } from "./colors";

describe("colorName", () => {
  it("names Gmail's label palette in plain words", () => {
    expect(colorName("#fb4c2f")).toBe("red");
    expect(colorName("#ffad47")).toBe("orange");
    expect(colorName("#fad165")).toBe("yellow");
    expect(colorName("#16a766")).toBe("green");
    expect(colorName("#43d692")).toBe("green");
    expect(colorName("#4a86e8")).toBe("blue");
    expect(colorName("#a479e2")).toBe("purple");
    expect(colorName("#f691b3")).toBe("pink");
    expect(colorName("#999999")).toBe("gray");
    expect(colorName("#ffffff")).toBe("white");
    expect(colorName("#000000")).toBe("black");
  });

  it("leaves anything that isn't a hex color alone", () => {
    expect(colorName("Priority")).toBeNull();
    expect(colorName("#fff")).toBeNull();
    expect(colorName("11")).toBeNull();
    expect(withColorName("Priority")).toBe("Priority");
  });

  it("puts the word after the code", () => {
    expect(withColorName("#fb4c2f")).toBe("#fb4c2f (red)");
  });
});
