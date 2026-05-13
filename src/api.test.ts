import { test, expect, spyOn, beforeEach, afterEach } from "bun:test";
import { callModel, callModelStructured, callInterpreterStructured, resetConfigForTesting } from "./api";
import { loadConfig as validateApiConfig } from "./config";

let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;

const ENV_KEYS = [
  "LM_STUDIO_URL",
  "OPENROUTER_API_KEY",
  "GEMINI_API_KEY",
  "NARRATOR_PROVIDER",
  "ARCHIVIST_PROVIDER",
  "INTERPRETER_PROVIDER",
  "USE_GEMINI_IMAGES",
  "USE_GEMINI_NARRATION",
  "LOCAL_NARRATOR_TEMP",
  "LOCAL_ARCHIVIST_TEMP",
  "LOCAL_INTERPRETER_TEMP",
  "LOCAL_NARRATOR_TOP_P",
  "LOCAL_ARCHIVIST_TOP_P",
  "LOCAL_INTERPRETER_TOP_P",
];

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  // Default to all-local with the test model so any test that doesn't
  // override the provider gets a valid config.
  process.env.NARRATOR_PROVIDER = "local,test-model";
  process.env.ARCHIVIST_PROVIDER = "local,test-model";
  process.env.INTERPRETER_PROVIDER = "local,test-model";
  resetConfigForTesting();
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
  await expect(callModel("system", "input")).rejects.toThrow("No content in response");
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
  fetchSpy.mockImplementationOnce(async () =>
    new Response(JSON.stringify({
      choices: [{ message: { content: "", reasoning_content: "" } }],
    }))
  );
  fetchSpy.mockImplementationOnce(async () =>
    new Response(JSON.stringify({
      choices: [{ message: { content: "", reasoning_content: "" } }],
    }))
  );
  await expect(
    callModelStructured("system", "input", "test", {})
  ).rejects.toThrow("No content in response");
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
  fetchSpy.mockImplementationOnce(async () =>
    new Response("Server error", { status: 500 })
  );
  fetchSpy.mockImplementationOnce(async () =>
    new Response("Server error", { status: 500 })
  );
  await expect(callModelStructured("system", "input", "test", {})).rejects.toThrow("API 500");
});

test("callModel: throws on invalid JSON response body", async () => {
  fetchSpy.mockImplementationOnce(async () =>
    new Response("not valid json")
  );
  await expect(callModel("system", "input")).rejects.toThrow("Invalid JSON from local API");
});

test("validateApiConfig: accepts NARRATOR_PROVIDER=openrouter with key set", () => {
  const orig = { ...process.env };
  process.env.NARRATOR_PROVIDER = "openrouter,test/model:free";
  process.env.OPENROUTER_API_KEY = "test-key";
  resetConfigForTesting();
  const exitSpy = spyOn(process, "exit").mockImplementation(() => { throw new Error("exit called"); });
  try {
    expect(() => validateApiConfig()).not.toThrow();
  } finally {
    exitSpy.mockRestore();
    process.env = orig;
  }
});

test("validateApiConfig: rejects gemini as a stage provider", () => {
  process.env.ARCHIVIST_PROVIDER = "gemini,gemini-2.5-flash";
  resetConfigForTesting();
  const exitSpy = spyOn(process, "exit").mockImplementation(() => { throw new Error("exit"); });
  try {
    expect(() => validateApiConfig()).toThrow();
  } finally {
    exitSpy.mockRestore();
  }
});

test("validateApiConfig: exits when any stage is openrouter but OPENROUTER_API_KEY missing", () => {
  const orig = { ...process.env };
  process.env.NARRATOR_PROVIDER = "openrouter,test/model:free";
  delete process.env.OPENROUTER_API_KEY;
  resetConfigForTesting();
  const errSpy = spyOn(console, "error").mockImplementation(() => {});
  const exitSpy = spyOn(process, "exit").mockImplementation((() => { throw new Error("exit"); }) as never);
  try {
    expect(() => validateApiConfig()).toThrow("exit");
    const calls = errSpy.mock.calls.map(c => String(c[0])).join("\n");
    expect(calls).toContain("OPENROUTER_API_KEY");
    expect(calls).toContain("NARRATOR_PROVIDER");
  } finally {
    errSpy.mockRestore();
    exitSpy.mockRestore();
    process.env = orig;
  }
});

test("openrouter narrator: posts to openrouter URL with bearer and configured model", async () => {
  process.env.NARRATOR_PROVIDER = "openrouter,test/model:free";
  process.env.OPENROUTER_API_KEY = "test-key";
  resetConfigForTesting();

  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  fetchSpy.mockImplementationOnce(async (url, init) => {
    capturedUrl = String(url);
    capturedInit = init;
    return new Response(JSON.stringify({
      choices: [{ message: { content: "remote prose", reasoning_content: "" } }],
    }));
  });

  const result = await callModel("system", "input");
  expect(result).toBe("remote prose");
  expect(capturedUrl).toBe("https://openrouter.ai/api/v1/chat/completions");
  const headers = capturedInit!.headers as Record<string, string>;
  expect(headers["Authorization"]).toBe("Bearer test-key");
  const body = JSON.parse(capturedInit!.body as string);
  expect(body.model).toBe("test/model:free");
});

test("openrouter narrator: uses model from NARRATOR_PROVIDER tuple", async () => {
  process.env.NARRATOR_PROVIDER = "openrouter,custom-model";
  process.env.OPENROUTER_API_KEY = "test-key";
  resetConfigForTesting();

  let capturedBody: { model: string } | undefined;
  fetchSpy.mockImplementationOnce(async (_url, init) => {
    capturedBody = JSON.parse((init as RequestInit).body as string);
    return new Response(JSON.stringify({
      choices: [{ message: { content: "x", reasoning_content: "" } }],
    }));
  });

  await callModel("system", "input");
  expect(capturedBody!.model).toBe("custom-model");
});

test("openrouter narrator: surfaces 429 rate-limit message", async () => {
  process.env.NARRATOR_PROVIDER = "openrouter,test/model:free";
  process.env.OPENROUTER_API_KEY = "test-key";
  resetConfigForTesting();

  fetchSpy.mockImplementationOnce(async () =>
    new Response(JSON.stringify({ error: { message: "Rate limit exceeded" } }), { status: 429 })
  );

  await expect(callModel("system", "input")).rejects.toThrow(/OpenRouter rate limit/);
});

test("openrouter interpreter: posts to openrouter URL with json schema + parses content", async () => {
  process.env.INTERPRETER_PROVIDER = "openrouter,test/model:free";
  process.env.OPENROUTER_API_KEY = "test-key";
  resetConfigForTesting();

  let capturedUrl = "";
  let capturedBody: { response_format: { type: string } } | undefined;
  fetchSpy.mockImplementationOnce(async (url, init) => {
    capturedUrl = String(url);
    capturedBody = JSON.parse((init as RequestInit).body as string);
    return new Response(JSON.stringify({
      choices: [{ message: { content: '{"direction":"north"}', reasoning_content: "" } }],
    }));
  });

  const result = await callInterpreterStructured<{ direction: string }>(
    "system", "go forth", "move", { type: "object" }
  );
  expect(result.direction).toBe("north");
  expect(capturedUrl).toBe("https://openrouter.ai/api/v1/chat/completions");
  expect(capturedBody!.response_format.type).toBe("json_schema");
});

test("openrouter interpreter: throws on invalid JSON in content", async () => {
  process.env.INTERPRETER_PROVIDER = "openrouter,test/model:free";
  process.env.OPENROUTER_API_KEY = "test-key";
  resetConfigForTesting();

  fetchSpy.mockImplementationOnce(async () =>
    new Response(JSON.stringify({
      choices: [{ message: { content: "not json", reasoning_content: "" } }],
    }))
  );

  await expect(
    callInterpreterStructured("system", "input", "test", {})
  ).rejects.toThrow(/Invalid JSON/);
});

test("openrouter archivist: posts to openrouter URL with json schema + retries on failure", async () => {
  process.env.ARCHIVIST_PROVIDER = "openrouter,test/model:free";
  process.env.OPENROUTER_API_KEY = "test-key";
  resetConfigForTesting();

  // First call fails, second succeeds — verifies the retry wrapper still applies
  fetchSpy
    .mockImplementationOnce(async () => new Response("Server error", { status: 500 }))
    .mockImplementationOnce(async () =>
      new Response(JSON.stringify({
        choices: [{ message: { content: '{"entries":["a","b"]}', reasoning_content: "" } }],
      }))
    );

  const result = await callModelStructured<{ entries: string[] }>(
    "system", "input", "facts", { type: "object" }
  );
  expect(result.entries).toEqual(["a", "b"]);
  expect(fetchSpy).toHaveBeenCalledTimes(2);
});

test("openrouter archivist: prefers content over reasoning_content", async () => {
  process.env.ARCHIVIST_PROVIDER = "openrouter,test/model:free";
  process.env.OPENROUTER_API_KEY = "test-key";
  resetConfigForTesting();

  fetchSpy.mockImplementationOnce(async () =>
    new Response(JSON.stringify({
      choices: [{
        message: {
          content: '{"entries":["from content"]}',
          reasoning_content: '{"entries":["from reasoning"]}',
        },
      }],
    }))
  );

  const result = await callModelStructured<{ entries: string[] }>(
    "system", "input", "facts", { type: "object" }
  );
  expect(result.entries).toEqual(["from content"]);
});
