import { describe, it, expect } from "vitest";
import { isAddressed } from "../src/protocol";

describe("isAddressed", () => {
  it("matches the wake name as a whole word, case-insensitively", () => {
    expect(isAddressed("Sam, what is the launch date?", "Sam")).toBe(true);
    expect(isAddressed("what do you think, sam", "Sam")).toBe(true);
  });
  it("does not match inside other words or other people", () => {
    expect(isAddressed("Samantha, can you go first?", "Sam")).toBe(false);
    expect(isAddressed("That is awesome", "Sam")).toBe(false);
    expect(isAddressed("Priya, what is the budget?", "Sam")).toBe(false);
  });
  it("never matches an empty wake name", () => {
    expect(isAddressed("anything at all", "")).toBe(false);
    expect(isAddressed("anything at all", "   ")).toBe(false);
  });
  it("escapes regex characters", () => {
    expect(isAddressed("hello", ".*")).toBe(false);
  });
});
