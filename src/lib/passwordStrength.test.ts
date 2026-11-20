import { describe, expect, it } from "vitest";
import { passwordStrength } from "./passwordStrength";

describe("passwordStrength", () => {
  it("rates common and short passwords low", () => {
    expect(passwordStrength("password").score).toBe(0);
    expect(passwordStrength("12345678").score).toBe(0);
    expect(passwordStrength("qwerty12").score).toBe(0);
    expect(passwordStrength("abc").score).toBe(0);
  });

  it("rewards length and variety", () => {
    expect(passwordStrength("Tiger-Moon-42").score).toBeGreaterThanOrEqual(2);
    expect(passwordStrength("correct horse battery staple").score).toBe(4);
    expect(passwordStrength("Xq9!vR2#mK7$").score).toBeGreaterThanOrEqual(3);
  });

  it("explains how to improve", () => {
    expect(passwordStrength("password123").hint).toMatch(/흔한/);
    expect(passwordStrength("correct horse battery staple").hint).toBe("");
  });
});
