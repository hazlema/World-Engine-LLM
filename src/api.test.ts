import { test, expect, spyOn, beforeEach, afterEach } from "bun:test";
import { callModel, callModelStructured, callInterpreterStructured, validateApiConfig } from "./api";

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

test("validateApiConfig: accepts NARRATOR_PROVIDER=openrouter with key set", () => {
  const orig = { ...process.env };
  process.env.NARRATOR_PROVIDER = "openrouter";
  process.env.OPENROUTER_API_KEY = "test-key";
  const exitSpy = spyOn(process, "exit").mockImplementation(() => { throw new Error("exit called"); });
  try {
    expect(() => validateApiConfig()).not.toThrow();
  } finally {
    exitSpy.mockRestore();
    process.env = orig;
  }
});

test("validateApiConfig: rejects ARCHIVIST_PROVIDER=gemini", () => {
  const orig = { ...process.env };
  process.env.ARCHIVIST_PROVIDER = "gemini";
  const errSpy = spyOn(console, "error").mockImplementation(() => {});
  const exitSpy = spyOn(process, "exit").mockImplementation((() => { throw new Error("exit"); }) as never);
  try {
    expect(() => validateApiConfig()).toThrow("exit");
    const calls = errSpy.mock.calls.map(c => String(c[0])).join("\n");
    expect(calls).toContain("ARCHIVIST_PROVIDER");
    expect(calls).toContain("local");
    expect(calls).toContain("openrouter");
  } finally {
    errSpy.mockRestore();
    exitSpy.mockRestore();
    process.env = orig;
  }
});

test("validateApiConfig: exits when any stage is openrouter but OPENROUTER_API_KEY missing", () => {
  const orig = { ...process.env };
  process.env.NARRATOR_PROVIDER = "openrouter";
  delete process.env.OPENROUTER_API_KEY;
  const errSpy = spyOn(console, "error").mockImplementation(() => {});
  const exitSpy = spyOn(process, "exit").mockImplementation((() => { throw new Error("exit"); }) as never);
  try {
    expect(() => validateApiConfig()).toThrow("exit");
    const calls = errSpy.mock.calls.map(c => String(c[0])).join("\n");
    expect(calls).toContain("OPENROUTER_API_KEY");
    expect(calls).toContain("NARRATOR_PROVIDER=openrouter");
  } finally {
    errSpy.mockRestore();
    exitSpy.mockRestore();
    process.env = orig;
  }
});

test("openrouter narrator: posts to openrouter URL with bearer + thinking on by default", async () => {
  const orig = { ...process.env };
  process.env.NARRATOR_PROVIDER = "openrouter";
  process.env.OPENROUTER_API_KEY = "test-key";
  process.env.OPENROUTER_MODEL = "test/model:free";
  delete process.env.OPENROUTER_NARRATOR_THINKING;

  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  fetchSpy.mockImplementationOnce(async (url, init) => {
    capturedUrl = String(url);
    capturedInit = init;
    return new Response(JSON.stringify({
      choices: [{ message: { content: "remote prose", reasoning_content: "" } }],
    }));
  });

  try {
    const result = await callModel("system", "input");
    expect(result).toBe("remote prose");
    expect(capturedUrl).toBe("https://openrouter.ai/api/v1/chat/completions");
    const headers = capturedInit!.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer test-key");
    const body = JSON.parse(capturedInit!.body as string);
    expect(body.model).toBe("test/model:free");
    expect(body.reasoning).toEqual({ effort: "medium" });
  } finally {
    process.env = orig;
  }
});

test("openrouter narrator: per-stage thinking=off disables reasoning", async () => {
  const orig = { ...process.env };
  process.env.NARRATOR_PROVIDER = "openrouter";
  process.env.OPENROUTER_API_KEY = "test-key";
  process.env.OPENROUTER_NARRATOR_THINKING = "off";

  let capturedBody: { reasoning: { effort: string } } | undefined;
  fetchSpy.mockImplementationOnce(async (_url, init) => {
    capturedBody = JSON.parse((init as RequestInit).body as string);
    return new Response(JSON.stringify({
      choices: [{ message: { content: "fast prose", reasoning_content: "" } }],
    }));
  });

  try {
    await callModel("system", "input");
    expect(capturedBody!.reasoning).toEqual({ effort: "off" });
  } finally {
    process.env = orig;
  }
});

test("openrouter narrator: uses OPENROUTER_NARRATOR_MODEL override when set", async () => {
  const orig = { ...process.env };
  process.env.NARRATOR_PROVIDER = "openrouter";
  process.env.OPENROUTER_API_KEY = "test-key";
  process.env.OPENROUTER_MODEL = "default/model:free";
  process.env.OPENROUTER_NARRATOR_MODEL = "specific/narrator:free";

  let capturedBody: { model: string } | undefined;
  fetchSpy.mockImplementationOnce(async (_url, init) => {
    capturedBody = JSON.parse((init as RequestInit).body as string);
    return new Response(JSON.stringify({
      choices: [{ message: { content: "x", reasoning_content: "" } }],
    }));
  });

  try {
    await callModel("system", "input");
    expect(capturedBody!.model).toBe("specific/narrator:free");
  } finally {
    process.env = orig;
  }
});

test("openrouter narrator: surfaces 429 rate-limit message", async () => {
  const orig = { ...process.env };
  process.env.NARRATOR_PROVIDER = "openrouter";
  process.env.OPENROUTER_API_KEY = "test-key";

  fetchSpy.mockImplementationOnce(async () =>
    new Response(JSON.stringify({ error: { message: "Rate limit exceeded" } }), { status: 429 })
  );

  try {
    await expect(callModel("system", "input")).rejects.toThrow(/OpenRouter rate limit/);
  } finally {
    process.env = orig;
  }
});

test("openrouter interpreter: posts to openrouter URL with json schema + parses content", async () => {
  const orig = { ...process.env };
  process.env.INTERPRETER_PROVIDER = "openrouter";
  process.env.OPENROUTER_API_KEY = "test-key";
  process.env.OPENROUTER_INTERPRETER_THINKING = "off";

  let capturedUrl = "";
  let capturedBody: { response_format: { type: string }; reasoning: { effort: string } } | undefined;
  fetchSpy.mockImplementationOnce(async (url, init) => {
    capturedUrl = String(url);
    capturedBody = JSON.parse((init as RequestInit).body as string);
    return new Response(JSON.stringify({
      choices: [{ message: { content: '{"direction":"north"}', reasoning_content: "" } }],
    }));
  });

  try {
    const result = await callInterpreterStructured<{ direction: string }>(
      "system", "go forth", "move", { type: "object" }
    );
    expect(result.direction).toBe("north");
    expect(capturedUrl).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(capturedBody!.response_format.type).toBe("json_schema");
    expect(capturedBody!.reasoning.effort).toBe("off");
  } finally {
    process.env = orig;
  }
});

test("openrouter interpreter: throws on invalid JSON in content", async () => {
  const orig = { ...process.env };
  process.env.INTERPRETER_PROVIDER = "openrouter";
  process.env.OPENROUTER_API_KEY = "test-key";

  fetchSpy.mockImplementationOnce(async () =>
    new Response(JSON.stringify({
      choices: [{ message: { content: "not json", reasoning_content: "" } }],
    }))
  );

  try {
    await expect(
      callInterpreterStructured("system", "input", "test", {})
    ).rejects.toThrow(/Invalid JSON/);
  } finally {
    process.env = orig;
  }
});

test("openrouter archivist: posts to openrouter URL with json schema + retries on failure", async () => {
  const orig = { ...process.env };
  process.env.ARCHIVIST_PROVIDER = "openrouter";
  process.env.OPENROUTER_API_KEY = "test-key";
  process.env.OPENROUTER_ARCHIVIST_THINKING = "off";

  // First call fails, second succeeds — verifies the retry wrapper still applies
  fetchSpy
    .mockImplementationOnce(async () => new Response("Server error", { status: 500 }))
    .mockImplementationOnce(async () =>
      new Response(JSON.stringify({
        choices: [{ message: { content: '{"entries":["a","b"]}', reasoning_content: "" } }],
      }))
    );

  try {
    const result = await callModelStructured<{ entries: string[] }>(
      "system", "input", "facts", { type: "object" }
    );
    expect(result.entries).toEqual(["a", "b"]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  } finally {
    process.env = orig;
  }
});

test("openrouter archivist: prefers content over reasoning_content", async () => {
  const orig = { ...process.env };
  process.env.ARCHIVIST_PROVIDER = "openrouter";
  process.env.OPENROUTER_API_KEY = "test-key";

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

  try {
    const result = await callModelStructured<{ entries: string[] }>(
      "system", "input", "facts", { type: "object" }
    );
    expect(result.entries).toEqual(["from content"]);
  } finally {
    process.env = orig;
  }
});
