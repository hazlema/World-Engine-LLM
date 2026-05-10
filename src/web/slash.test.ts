import { test, expect } from "bun:test";
import { parseSlashCommand } from "./slash";

test("parseSlashCommand: returns null for plain text", () => {
  expect(parseSlashCommand("look around")).toBeNull();
  expect(parseSlashCommand("")).toBeNull();
  expect(parseSlashCommand("   ")).toBeNull();
});

test("parseSlashCommand: returns null for text not starting with /", () => {
  expect(parseSlashCommand("debug")).toBeNull();
  expect(parseSlashCommand("a/b")).toBeNull();
});

test("parseSlashCommand: parses bare command", () => {
  expect(parseSlashCommand("/debug")).toEqual({ name: "debug", args: "" });
  expect(parseSlashCommand("  /debug  ")).toEqual({ name: "debug", args: "" });
});

test("parseSlashCommand: parses command with args", () => {
  expect(parseSlashCommand("/foo bar baz")).toEqual({ name: "foo", args: "bar baz" });
});

test("parseSlashCommand: lowercases command name", () => {
  expect(parseSlashCommand("/DEBUG")).toEqual({ name: "debug", args: "" });
});

test("parseSlashCommand: ignores empty slash", () => {
  expect(parseSlashCommand("/")).toBeNull();
  expect(parseSlashCommand("/   ")).toBeNull();
});
