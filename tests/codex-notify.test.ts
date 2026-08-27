import { afterEach, describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ConfigError,
  destinationDigest,
  isActivityEvent,
  loadConfig,
  notificationText,
  processTurn,
  readTurnStatus,
  sessionBusAddress,
  sendDestination,
  spawnWorker,
  turnDigest,
  workerCommand,
  type Destination,
  type NotifyConfig,
} from "../src/codex-notify.ts";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const path = join(tmpdir(), `codex-notify-test-${crypto.randomUUID()}`);
  mkdirSync(path, { mode: 0o700 });
  temporaryDirectories.push(path);
  return path;
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
  mock.restore();
});

const ntfy: Destination = {
  type: "ntfy",
  url: "https://example.invalid/synthetic-topic",
};
const telegram: Destination = {
  type: "telegram",
  bot_token: "synthetic-token",
  chat_id: "100",
};

describe("configuration", () => {
  test("loads a private configuration", () => {
    const path = join(temporaryDirectory(), "config.json");
    writeFileSync(path, JSON.stringify({ destinations: [ntfy] }), {
      mode: 0o600,
    });
    expect(loadConfig(path).destinations).toEqual([ntfy]);
  });

  test("rejects public permissions", () => {
    const path = join(temporaryDirectory(), "config.json");
    writeFileSync(path, JSON.stringify({ destinations: [ntfy] }), {
      mode: 0o600,
    });
    chmodSync(path, 0o644);
    expect(() => loadConfig(path)).toThrow(ConfigError);
  });

  test("rejects an invalid presence grace", () => {
    const path = join(temporaryDirectory(), "config.json");
    writeFileSync(
      path,
      JSON.stringify({
        destinations: [ntfy],
        presence: { enabled: true, grace_seconds: "soon" },
      }),
      { mode: 0o600 },
    );
    expect(() => loadConfig(path)).toThrow("presence.grace_seconds");
  });
});

describe("completion and deduplication", () => {
  test("reads the exact completed turn", () => {
    const path = join(temporaryDirectory(), "history.sqlite");
    const database = new Database(path);
    database.run(
      "CREATE TABLE thread_turns (thread_id TEXT, turn_id TEXT, status TEXT, completed_at INTEGER)",
    );
    database.run("INSERT INTO thread_turns VALUES (?, ?, ?, ?)", [
      "thread-1",
      "turn-1",
      "completed",
      123,
    ]);
    database.close();
    expect(readTurnStatus("thread-1", "turn-1", path)).toEqual({
      status: "completed",
      completedAt: 123,
    });
  });

  test("waits for the exact turn to become terminal before sending", async () => {
    const state = temporaryDirectory();
    const historyPath = join(state, "history.sqlite");
    writeFileSync(historyPath, "synthetic", { mode: 0o600 });
    const statuses = [
      { status: "in_progress", completedAt: null },
      { status: "completed", completedAt: 123 },
    ];
    const statusReader = mock(() => statuses.shift() ?? statuses.at(-1)!);
    const sleep = mock(async () => {});
    const sender = mock(async () => true);
    expect(
      await processTurn(
        { destinations: [ntfy], presence: { enabled: false } },
        "thread-wait",
        "turn-wait",
        "completed",
        {
          state,
          historyPath,
          statusReader,
          sleep,
          sender,
        },
      ),
    ).toBe("sent");
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sender).toHaveBeenCalledWith(ntfy, "completed");
  });

  test("spawns a detached worker and leaves a private request", () => {
    const root = temporaryDirectory();
    const state = join(root, "state");
    const previousState = process.env.CODEX_NOTIFY_STATE_DIRECTORY;
    process.env.CODEX_NOTIFY_STATE_DIRECTORY = state;
    let options: Record<string, unknown> | undefined;
    const unref = mock(() => {});
    const spawn = mock((supplied: Record<string, unknown>) => {
      options = supplied;
      return { unref };
    }) as unknown as typeof Bun.spawn;
    try {
      spawnWorker(
        {
          threadId: "thread-main",
          turnId: "turn-main",
          status: "completed",
        },
        spawn,
      );
      expect(options?.detached).toBe(true);
      expect(options?.stdin).toBe("ignore");
      expect(unref).toHaveBeenCalledTimes(1);
      const names = readdirSync(state);
      expect(names.some((name) => name.startsWith("request-"))).toBe(true);
      expect(names.some((name) => name.endsWith(".json"))).toBe(true);
    } finally {
      if (previousState === undefined)
        delete process.env.CODEX_NOTIFY_STATE_DIRECTORY;
      else process.env.CODEX_NOTIFY_STATE_DIRECTORY = previousState;
    }
  });

  test("builds source and compiled worker commands without extra arguments", () => {
    expect(
      workerCommand("digest", "/usr/bin/bun", "/project/src/codex-notify.ts"),
    ).toEqual([
      "/usr/bin/bun",
      "/project/src/codex-notify.ts",
      "--worker",
      "digest",
    ]);
    expect(
      workerCommand(
        "digest",
        "/project/dist/codex-notify",
        "/$bunfs/root/codex-notify",
      ),
    ).toEqual(["/project/dist/codex-notify", "--worker", "digest"]);
  });

  test("sends every destination once", async () => {
    const state = temporaryDirectory();
    const config: NotifyConfig = {
      destinations: [ntfy, telegram],
      presence: { enabled: false },
    };
    const sent: string[] = [];
    const sender = async (destination: Destination) => {
      sent.push(destination.type);
      return true;
    };
    expect(
      await processTurn(config, "thread-1", "turn-1", "completed", {
        state,
        historyPath: join(state, "missing"),
        sender,
      }),
    ).toBe("sent");
    expect(
      await processTurn(config, "thread-1", "turn-1", "completed", {
        state,
        historyPath: join(state, "missing"),
        sender,
      }),
    ).toBe("duplicate");
    expect(sent).toEqual(["ntfy", "telegram"]);
  });

  test("identical destinations are sent once", async () => {
    const state = temporaryDirectory();
    const sender = mock(async () => true);
    await processTurn(
      { destinations: [ntfy, { ...ntfy }], presence: { enabled: false } },
      "thread-1",
      "turn-2",
      "completed",
      {
        state,
        historyPath: join(state, "missing"),
        sender,
      },
    );
    expect(sender).toHaveBeenCalledTimes(1);
  });

  test("presence suppression is enabled by default", async () => {
    const state = temporaryDirectory();
    const sender = mock(async () => true);
    const acknowledgementChecker = mock(async () => true);
    const outcome = await processTurn(
      { destinations: [ntfy], presence: { grace_seconds: 3 } },
      "thread-1",
      "turn-present",
      "completed",
      {
        state,
        historyPath: join(state, "missing"),
        sender,
        acknowledgementChecker,
      },
    );
    expect(outcome).toBe("skipped-present");
    expect(acknowledgementChecker).toHaveBeenCalledWith(3);
    expect(sender).not.toHaveBeenCalled();
  });

  test("presence suppression can be disabled", async () => {
    const state = temporaryDirectory();
    const sender = mock(async () => true);
    const acknowledgementChecker = mock(async () => true);
    const outcome = await processTurn(
      { destinations: [ntfy], presence: { enabled: false } },
      "thread-1",
      "turn-opt-out",
      "completed",
      {
        state,
        historyPath: join(state, "missing"),
        sender,
        acknowledgementChecker,
      },
    );
    expect(outcome).toBe("sent");
    expect(acknowledgementChecker).not.toHaveBeenCalled();
    expect(sender).toHaveBeenCalledTimes(1);
  });

  test("uses stable hashes without writing secrets", async () => {
    expect(turnDigest("thread", "turn")).toHaveLength(64);
    expect(destinationDigest(telegram)).toHaveLength(16);
    const state = temporaryDirectory();
    await processTurn(
      { destinations: [telegram], presence: { enabled: false } },
      "thread",
      "turn",
      "completed",
      {
        state,
        historyPath: join(state, "missing"),
        sender: async () => true,
      },
    );
    const names = readdirSync(state).join(" ");
    expect(names).not.toContain("synthetic-token");
    expect(names).not.toContain("100");
  });

  test("uses the terminal status from the hook event", async () => {
    const state = temporaryDirectory();
    const statuses: string[] = [];
    expect(
      await processTurn(
        { destinations: [ntfy], presence: { enabled: false } },
        "thread-hook",
        "turn-hook",
        "completed",
        {
          state,
          historyPath: join(state, "missing"),
          sender: async (_destination, status) => {
            statuses.push(status);
            return true;
          },
        },
      ),
    ).toBe("sent");
    expect(statuses).toEqual(["completed"]);
  });
});

describe("destinations", () => {
  test("sends a generic ntfy request", async () => {
    let request: Request | undefined;
    const fetcher = mock(
      async (input: string | URL | Request, init?: RequestInit) => {
        request = new Request(input, init);
        return new Response("", { status: 200 });
      },
    ) as unknown as typeof fetch;
    expect(await sendDestination(ntfy, "completed", fetcher)).toEqual({
      ok: true,
      httpStatus: 200,
    });
    expect(request?.url).toBe(ntfy.url);
    expect(await request?.text()).toBe("Codex task finished.");
  });

  test("sends Telegram chat ID and generic text", async () => {
    let request: Request | undefined;
    const fetcher = mock(
      async (input: string | URL | Request, init?: RequestInit) => {
        request = new Request(input, init);
        return Response.json({ ok: true });
      },
    ) as unknown as typeof fetch;
    expect(await sendDestination(telegram, "completed", fetcher)).toEqual({
      ok: true,
      httpStatus: 200,
    });
    expect(request?.url).toBe(
      "https://api.telegram.org/botsynthetic-token/sendMessage",
    );
    expect(await request?.json()).toEqual({
      chat_id: "100",
      text: "Codex task finished\nCodex task finished.",
    });
  });

  test("reports an HTTP failure without response content", async () => {
    const fetcher = mock(
      async () => new Response("sensitive upstream detail", { status: 403 }),
    ) as unknown as typeof fetch;
    expect(await sendDestination(ntfy, "completed", fetcher)).toEqual({
      ok: false,
      phase: "http",
      httpStatus: 403,
    });
  });

  test("classifies DNS failures without destination data", async () => {
    const fetcher = mock(async () => {
      throw Object.assign(new Error("request failed for synthetic topic"), {
        code: "ENOTFOUND",
      });
    }) as unknown as typeof fetch;
    expect(await sendDestination(ntfy, "completed", fetcher)).toEqual({
      ok: false,
      phase: "dns",
      errorCode: "ENOTFOUND",
      errorName: "Error",
    });
  });
});

describe("private diagnostics", () => {
  test("records safe delivery details and attempt count", async () => {
    const state = temporaryDirectory();
    const config: NotifyConfig = {
      destinations: [telegram],
      presence: { enabled: false },
    };
    const options = {
      state,
      historyPath: join(state, "missing"),
      sender: async () => ({
        ok: false as const,
        phase: "timeout" as const,
        errorCode: "ETIMEOUT",
      }),
    };
    expect(
      await processTurn(config, "thread", "failed-turn", "completed", options),
    ).toBe("send-failed");
    expect(
      await processTurn(config, "thread", "failed-turn", "completed", options),
    ).toBe("send-failed");
    const diagnosticName = readdirSync(state).find((name) =>
      name.startsWith("delivery-"),
    );
    expect(diagnosticName).toBeDefined();
    const text = readFileSync(join(state, diagnosticName!), "utf8");
    expect(text).not.toContain(telegram.bot_token);
    expect(text).not.toContain(telegram.chat_id);
    expect(JSON.parse(text)).toMatchObject({
      destinationType: "telegram",
      outcome: "failed",
      attempt: 2,
      phase: "timeout",
      errorCode: "ETIMEOUT",
    });
  });
});

describe("presence primitives", () => {
  test("uses the configured session bus address", () => {
    expect(
      sessionBusAddress(
        { DBUS_SESSION_BUS_ADDRESS: "unix:path=/synthetic/session-bus" },
        1000,
      ),
    ).toBe("unix:path=/synthetic/session-bus");
  });

  test("derives a session bus path without X11", () => {
    expect(
      sessionBusAddress({ XDG_RUNTIME_DIR: "/synthetic/runtime" }, 1000),
    ).toBe("unix:path=/synthetic/runtime/bus");
    expect(sessionBusAddress({}, 1001)).toBe("unix:path=/run/user/1001/bus");
    expect(
      sessionBusAddress(
        {
          DBUS_SESSION_BUS_ADDRESS: "unix:abstract=/synthetic/unsupported",
          XDG_RUNTIME_DIR: "/synthetic/runtime",
        },
        1000,
      ),
    ).toBe("unix:path=/synthetic/runtime/bus");
  });

  test("filters Linux input events", () => {
    expect(isActivityEvent(1, 1)).toBe(true);
    expect(isActivityEvent(1, 0)).toBe(false);
    expect(isActivityEvent(2, 2)).toBe(true);
    expect(isActivityEvent(0, 1)).toBe(false);
  });

  test("formats only generic completion text", () => {
    expect(notificationText("completed")).toEqual({
      title: "Codex task finished",
      body: "Codex task finished.",
      tags: "white_check_mark",
    });
  });
});
