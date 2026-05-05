import { test, expect, spyOn, beforeEach, afterEach } from "bun:test";
import { callModel, callModelStructured } from "./api";

let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;

beforeEach(() => {
  fetchSpy = spyOn(globalThis, "fetch");
});

afterEach(() => {
  fetchSpy.mockRestore();
});

// callModel tests

test("callModel: extracts content from completions response", async () => {
  fetchSpy.mockImplementationOnce(async () =>
    new Response(JSON.stringify({
      choices: [{ message: { content: "The world shivers.", reasoning_content: "" } }],
    }))
  );
  expect(await callModel("system", "input")).toBe("The world shivers.");
});

test("callModel: throws on empty content and reasoning", async () => {
  fetchSpy.mockImplementationOnce(async () =>
    new Response(JSON.stringify({
      choices: [{ message: { content: "", reasoning_content: "" } }],
    }))
  );
  await expect(callModel("system", "input")).rejects.toThrow("No message in response");
});

test("callModel: throws on non-ok response", async () => {
  fetchSpy.mockImplementationOnce(async () =>
    new Response("Server error", { status: 500 })
  );
  await expect(callModel("system", "input")).rejects.toThrow("API 500");
});

test("callModel: falls back to reasoning_content when content empty", async () => {
  fetchSpy.mockImplementationOnce(async () =>
    new Response(JSON.stringify({
      choices: [{ message: { content: "", reasoning_content: "The crow watches." } }],
    }))
  );
  expect(await callModel("system", "input")).toBe("The crow watches.");
});

// callModelStructured tests

test("callModelStructured: extracts from reasoning_content when content empty", async () => {
  fetchSpy.mockImplementationOnce(async () =>
    new Response(JSON.stringify({
      choices: [{
        message: {
          content: "",
          reasoning_content: '{"entries":["world is cold","crow watches"]}',
        },
      }],
    }))
  );
  const result = await callModelStructured<{ entries: string[] }>(
    "system", "input", "test", {}
  );
  expect(result.entries).toEqual(["world is cold", "crow watches"]);
});

test("callModelStructured: extracts from content when reasoning_content empty", async () => {
  fetchSpy.mockImplementationOnce(async () =>
    new Response(JSON.stringify({
      choices: [{
        message: {
          content: '{"entries":["lone fact"]}',
          reasoning_content: "",
        },
      }],
    }))
  );
  const result = await callModelStructured<{ entries: string[] }>(
    "system", "input", "test", {}
  );
  expect(result.entries).toEqual(["lone fact"]);
});

test("callModelStructured: throws on empty content and reasoning_content", async () => {
  fetchSpy.mockImplementationOnce(async () =>
    new Response(JSON.stringify({
      choices: [{ message: { content: "", reasoning_content: "" } }],
    }))
  );
  await expect(
    callModelStructured("system", "input", "test", {})
  ).rejects.toThrow("No content in structured response");
});

test("callModel: translates AbortError to API timeout", async () => {
  fetchSpy.mockImplementationOnce(() =>
    Promise.reject(new DOMException("aborted", "AbortError"))
  );
  await expect(callModel("system", "input")).rejects.toThrow("API timeout");
});

test("callModelStructured: throws on non-ok response", async () => {
  fetchSpy.mockImplementationOnce(async () =>
    new Response("Server error", { status: 500 })
  );
  await expect(callModelStructured("system", "input", "test", {})).rejects.toThrow("API 500");
});

test("callModel: throws on invalid JSON response body", async () => {
  fetchSpy.mockImplementationOnce(async () =>
    new Response("not valid json")
  );
  await expect(callModel("system", "input")).rejects.toThrow("Invalid JSON from narrator API");
});
