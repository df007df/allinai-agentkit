import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createClaudeAdapter, type ClaudeQueryFactory } from "./claude.js";
import { OptionalRuntimeDependencyError } from "./codex.js";

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}

function runInput() {
  return {
    prompt: "Summarise the repository",
    options: {
      cwd: "/work/project",
      model: "claude-sonnet-4-6",
      includePartialMessages: true,
    },
  };
}

describe("Claude adapter", () => {
  it("reports the installed SDK boundary without claiming auth health", async () => {
    const adapter = createClaudeAdapter({
      loadClaude: async () => ({
        query: (() => {
          throw new Error("probe must not invoke the SDK query");
        }) as ClaudeQueryFactory,
      }),
    });

    assert.deepEqual(await adapter.probe(), { installed: true, version: null });
  });

  it("raises an actionable optional dependency error when the SDK is absent", async () => {
    const adapter = createClaudeAdapter({
      loadClaude: async () => {
        throw new Error("Cannot find package");
      },
    });

    await assert.rejects(adapter.probe(), (error: unknown) => {
      assert.ok(error instanceof OptionalRuntimeDependencyError);
      assert.equal(error.packageName, "@anthropic-ai/claude-agent-sdk");
      assert.match(
        error.message,
        /npm install @anthropic-ai\/claude-agent-sdk/,
      );
      return true;
    });
  });

  it("propagates an actionable optional dependency error from adapter use", async () => {
    const adapter = createClaudeAdapter({
      loadClaude: async () => {
        throw new Error("Cannot find package");
      },
    });

    await assert.rejects(
      collect(adapter.start(runInput(), new AbortController().signal)),
      (error: unknown) => {
        assert.ok(error instanceof OptionalRuntimeDependencyError);
        assert.equal(error.packageName, "@anthropic-ai/claude-agent-sdk");
        assert.match(
          error.message,
          /npm install @anthropic-ai\/claude-agent-sdk/,
        );
        return true;
      },
    );
  });

  it("maps official SDK messages into normalized init, text and done events", async () => {
    const adapter = createClaudeAdapter({
      query: (({ prompt, options }: Parameters<ClaudeQueryFactory>[0]) => {
        assert.equal(prompt, "Summarise the repository");
        assert.equal(options?.cwd, "/work/project");
        return fakeQuery([
          { type: "system", subtype: "init", session_id: "claude-thread-1" },
          {
            type: "stream_event",
            event: {
              type: "content_block_delta",
              delta: { type: "text_delta", text: "Hello" },
            },
          },
          { type: "result", subtype: "success", result: "Hello" },
        ]);
      }) as ClaudeQueryFactory,
    });

    const events = await collect(
      adapter.start(runInput(), new AbortController().signal),
    );

    assert.deepEqual(
      events.map((event) => event.type),
      ["init", "text_delta", "done"],
    );
    assert.equal(events[0]?.payload?.runtimeSessionId, "claude-thread-1");
    assert.equal(events[1]?.payload?.text, "Hello");
    assert.equal(events[2]?.payload?.result, "Hello");
  });

  it("asks the injected AskUser hook instead of importing a Domain bridge", async () => {
    const asked: string[] = [];
    let canUseTool:
      | ((
          toolName: string,
          input: Record<string, unknown>,
          options: { toolUseID: string; signal: AbortSignal },
        ) => Promise<unknown>)
      | undefined;
    const adapter = createClaudeAdapter({
      query: (({ options }: Parameters<ClaudeQueryFactory>[0]) => {
        canUseTool = options?.canUseTool as typeof canUseTool;
        return fakeQuery([
          { type: "result", subtype: "success", result: "done" },
        ]);
      }) as ClaudeQueryFactory,
    });

    await collect(
      adapter.start(
        {
          ...runInput(),
          onAskUser: async (_toolName, _input, options) => {
            asked.push(options.toolUseID);
            return { behavior: "allow", updatedInput: { answer: "yes" } };
          },
        },
        new AbortController().signal,
      ),
    );
    await canUseTool?.(
      "AskUserQuestion",
      {},
      {
        toolUseID: "tool-1",
        signal: new AbortController().signal,
      },
    );

    assert.deepEqual(asked, ["tool-1"]);
  });

  it("closes the official Query when its supplied signal is aborted", async () => {
    const controller = new AbortController();
    let closed = 0;
    const adapter = createClaudeAdapter({
      query: (() =>
        fakeQuery(
          (async function* () {
            await new Promise<void>((resolve) => {
              controller.signal.addEventListener("abort", () => resolve(), {
                once: true,
              });
            });
          })(),
          () => {
            closed += 1;
          },
        )) as ClaudeQueryFactory,
    });

    const stream = adapter.start(runInput(), controller.signal);
    const iterator = stream[Symbol.asyncIterator]();
    const next = iterator.next();
    controller.abort();
    assert.equal((await next).value?.type, "done");
    await iterator.next();
    assert.equal(closed, 1);
  });
});

function fakeQuery(
  messages: Iterable<unknown> | AsyncIterable<unknown>,
  onClose?: () => void,
): ReturnType<ClaudeQueryFactory> {
  const iterator = (async function* () {
    for await (const message of messages) yield message;
  })();
  return Object.assign(iterator, {
    interrupt: async () => undefined,
    setPermissionMode: async () => undefined,
    setModel: async () => undefined,
    setMaxThinkingTokens: async () => undefined,
    applyFlagSettings: async () => undefined,
    initializationResult: async () => ({}),
    supportedCommands: async () => [],
    supportedModels: async () => [],
    supportedAgents: async () => [],
    mcpServerStatus: async () => [],
    getContextUsage: async () => ({}),
    readFile: async () => null,
    reloadPlugins: async () => ({}),
    reloadSkills: async () => ({}),
    accountInfo: async () => ({}),
    rewindFiles: async () => ({}),
    seedReadState: async () => undefined,
    reconnectMcpServer: async () => undefined,
    toggleMcpServer: async () => undefined,
    setMcpServers: async () => ({}),
    streamInput: async () => undefined,
    stopTask: async () => undefined,
    backgroundTasks: async () => false,
    close: () => onClose?.(),
  }) as unknown as ReturnType<ClaudeQueryFactory>;
}
