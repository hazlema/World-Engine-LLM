import { test, expect } from "bun:test";
import { diffNewItems } from "./utils";

test("diffNewItems: empty prev returns all curr", () => {
  expect(diffNewItems([], ["a", "b"])).toEqual(["a", "b"]);
});

test("diffNewItems: no new items returns empty", () => {
  expect(diffNewItems(["a", "b"], ["a", "b"])).toEqual([]);
});

test("diffNewItems: returns only items not in prev", () => {
  expect(diffNewItems(["a"], ["a", "b", "c"])).toEqual(["b", "c"]);
});

test("diffNewItems: handles removed items gracefully (returns nothing extra)", () => {
  expect(diffNewItems(["a", "b"], ["a"])).toEqual([]);
});

test("diffNewItems: both empty returns empty", () => {
  expect(diffNewItems([], [])).toEqual([]);
});
