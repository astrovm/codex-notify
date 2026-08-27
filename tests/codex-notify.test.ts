import { afterEach, describe, expect, mock, test } from "bun:test";
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
  main,
  notificationText,
  processTurn,
  sessionBusAddress,
  sendDestination,
  turnDigest,
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
  test("handles a completion synchronously without a queue", async () => {
    const root = temporaryDirectory();
    const configPath = join(root, "config.json");
    const state = join(root, "state");
    writeFileSync(
      configPath,
      JSON.stringify({
        destinations: [ntfy],
        presence: { enabled: false },
      }),
      { mode: 0o600 },
    );
    const previousConfig = process.env.CODEX_NOTIFY_CONFIG;
    const previousState = process.env.CODEX_NOTIFY_STATE_DIRECTORY;
    const previousFetch = globalThis.fetch;
    process.env.CODEX_NOTIFY_CONFIG = configPath;
    process.env.CODEX_NOTIFY_STATE_DIRECTORY = state;
    globalThis.fetch = mock(
      async () => new Response("", { status: 200 }),
    ) as unknown as typeof fetch;
    try {
      expect(
        await main([
          JSON.stringify({
            type: "agent-turn-complete",
            "thread-id": "thread-main",
            "turn-id": "turn-main",
            status: "completed",
          }),
        ]),
      ).toBe(0);
      const names = readdirSync(state);
      expect(names.some((name) => name.startsWith("sent-"))).toBe(true);
      expect(names.some((name) => name.startsWith("request-"))).toBe(false);
    } finally {
      globalThis.fetch = previousFetch;
      if (previousConfig === undefined) delete process.env.CODEX_NOTIFY_CONFIG;
      else process.env.CODEX_NOTIFY_CONFIG = previousConfig;
      if (previousState === undefined)
        delete process.env.CODEX_NOTIFY_STATE_DIRECTORY;
      else process.env.CODEX_NOTIFY_STATE_DIRECTORY = previousState;
    }
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
        sender,
      }),
    ).toBe("sent");
    expect(
      await processTurn(config, "thread-1", "turn-1", "completed", {
        state,
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
