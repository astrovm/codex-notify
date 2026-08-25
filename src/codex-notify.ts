#!/usr/bin/env bun

import { Database } from "bun:sqlite";
import { dlopen, FFIType } from "bun:ffi";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { homedir, platform } from "node:os";

export const POLL_MILLISECONDS = 250;
export const MAX_WAIT_MILLISECONDS = 24 * 60 * 60 * 1_000;
export const TERMINAL_TURN_STATUSES = new Set(["completed", "failed", "interrupted"]);

const INPUT_EVENT_SIZE = 24;
const INPUT_EVENT_TYPE_OFFSET = 16;
const INPUT_EVENT_VALUE_OFFSET = 20;
const EV_KEY = 0x01;
const EV_REL = 0x02;
const EV_ABS = 0x03;

export type TerminalStatus = "completed" | "failed" | "interrupted";

export interface NtfyDestination {
  type: "ntfy";
  url: string;
}

export interface TelegramDestination {
  type: "telegram";
  bot_token: string;
  chat_id: string;
}

export type Destination = NtfyDestination | TelegramDestination;

export interface NotifyConfig {
  destinations: Destination[];
  presence?: {
    enabled?: boolean;
    grace_seconds?: number;
  };
}

export interface TurnStatus {
  status: string;
  completedAt: number | null;
}

export interface WorkerRequest {
  threadId: string;
  turnId: string;
  status: TerminalStatus;
}

export interface ProcessTurnOptions {
  statusReader?: (threadId: string, turnId: string) => TurnStatus | null;
  acknowledgementChecker?: (graceSeconds: number) => Promise<boolean>;
  sender?: (destination: Destination, status: TerminalStatus) => Promise<boolean>;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  maximumWaitMilliseconds?: number;
  state?: string;
  historyPath?: string;
}

export class ConfigError extends Error {}

function envPath(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

export function codexHome(): string {
  return envPath("CODEX_HOME") ?? join(homedir(), ".codex");
}

export function configPath(): string {
  const override = envPath("CODEX_NOTIFY_CONFIG");
  if (override) return override;
  if (platform() === "darwin") {
    return join(homedir(), "Library", "Application Support", "codex-notify", "config.json");
  }
  const root = envPath("XDG_CONFIG_HOME") ?? join(homedir(), ".config");
  return join(root, "codex-notify", "config.json");
}

export function stateDirectory(): string {
  const override = envPath("CODEX_NOTIFY_STATE_DIRECTORY");
  if (override) return override;
  if (platform() === "darwin") {
    return join(homedir(), "Library", "Application Support", "codex-notify", "state");
  }
  const root = envPath("XDG_STATE_HOME") ?? join(homedir(), ".local", "state");
  return join(root, "codex-notify");
}

export function historyDatabase(): string {
  return envPath("CODEX_NOTIFY_HISTORY_DATABASE") ?? join(codexHome(), "thread_history_1.sqlite");
}

function requirePrivateFile(path: string): void {
  let mode: number;
  try {
    mode = statSync(path).mode & 0o777;
  } catch (error) {
    throw new ConfigError(`configuration file not found: ${path}`, { cause: error });
  }
  if ((mode & 0o077) !== 0) {
    throw new ConfigError(`configuration must not be accessible by group or others: ${path}`);
  }
}

function validateDestination(value: unknown): asserts value is Destination {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError("each destination must be a JSON object");
  }
  const destination = value as Record<string, unknown>;
  if (destination.type === "ntfy") {
    if (typeof destination.url !== "string" || !destination.url) {
      throw new ConfigError("an ntfy destination requires url");
    }
    return;
  }
  if (destination.type === "telegram") {
    if (typeof destination.bot_token !== "string" || !destination.bot_token) {
      throw new ConfigError("a Telegram destination requires bot_token");
    }
    if (typeof destination.chat_id !== "string" || !destination.chat_id) {
      throw new ConfigError("a Telegram destination requires chat_id");
    }
    return;
  }
  throw new ConfigError(`unsupported destination type: ${String(destination.type)}`);
}

export function loadConfig(path = configPath()): NotifyConfig {
  requirePrivateFile(path);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new ConfigError(`invalid configuration: ${path}`, { cause: error });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError("configuration must be a JSON object");
  }
  const config = value as Partial<NotifyConfig>;
  if (!Array.isArray(config.destinations) || config.destinations.length === 0) {
    throw new ConfigError("destinations must be a non-empty list");
  }
  config.destinations.forEach(validateDestination);
  if (config.presence !== undefined) {
    if (!config.presence || typeof config.presence !== "object" || Array.isArray(config.presence)) {
      throw new ConfigError("presence must be a JSON object");
    }
    if (config.presence.enabled !== undefined && typeof config.presence.enabled !== "boolean") {
      throw new ConfigError("presence.enabled must be true or false");
    }
    const grace = config.presence.grace_seconds ?? 8;
    if (typeof grace !== "number" || !Number.isFinite(grace) || grace < 0 || grace > 300) {
      throw new ConfigError("presence.grace_seconds must be a number from 0 to 300");
    }
  }
  return config as NotifyConfig;
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function turnDigest(threadId: string, turnId: string): string {
  return hash([threadId, turnId]);
}

export function destinationDigest(destination: Destination): string {
  const sorted = Object.fromEntries(Object.entries(destination).sort(([a], [b]) => a.localeCompare(b)));
  return hash(sorted).slice(0, 16);
}

export function readTurnStatus(
  threadId: string,
  turnId: string,
  databasePath = historyDatabase(),
): TurnStatus | null {
  if (!existsSync(databasePath)) return null;
  let database: Database | undefined;
  try {
    database = new Database(databasePath, { readonly: true, strict: true });
    const row = database
      .query("SELECT status, completed_at FROM thread_turns WHERE thread_id = ? AND turn_id = ?")
      .get(threadId, turnId) as { status: unknown; completed_at: unknown } | null;
    if (!row) return null;
    return {
      status: String(row.status),
      completedAt: row.completed_at === null ? null : Number(row.completed_at),
    };
  } catch {
    return null;
  } finally {
    database?.close();
  }
}

export function isActivityEvent(eventType: number, value: number): boolean {
  if (eventType === EV_KEY) return value === 1 || value === 2;
  return (eventType === EV_REL || eventType === EV_ABS) && value !== 0;
}

export async function linuxActivityAfterCompletion(timeoutSeconds: number): Promise<boolean> {
  const descriptors: number[] = [];
  try {
    let names: string[];
    try {
      names = readdirSync("/dev/input").filter((name) => name.startsWith("event"));
    } catch {
      return false;
    }
    for (const name of names) {
      try {
        descriptors.push(openSync(join("/dev/input", name), constants.O_RDONLY | constants.O_NONBLOCK));
      } catch {
        // A missing or unreadable input device makes this probe less complete, not fatal.
      }
    }
    if (descriptors.length === 0) return false;
    const buffer = Buffer.alloc(INPUT_EVENT_SIZE * 64);
    const deadline = Date.now() + Math.max(0, timeoutSeconds) * 1_000;
    while (Date.now() < deadline) {
      for (const descriptor of descriptors) {
        try {
          const length = readSync(descriptor, buffer, 0, buffer.length, null);
          const complete = length - (length % INPUT_EVENT_SIZE);
          for (let offset = 0; offset < complete; offset += INPUT_EVENT_SIZE) {
            const eventType = buffer.readUInt16LE(offset + INPUT_EVENT_TYPE_OFFSET);
            const value = buffer.readInt32LE(offset + INPUT_EVENT_VALUE_OFFSET);
            if (isActivityEvent(eventType, value)) return true;
          }
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "EAGAIN" && code !== "EWOULDBLOCK") continue;
        }
      }
      await Bun.sleep(50);
    }
    return false;
  } finally {
    for (const descriptor of descriptors) {
      try {
        closeSync(descriptor);
      } catch {
        // Already closed.
      }
    }
  }
}

interface CommandResult {
  success: boolean;
  stdout: string;
  stderr: string;
}

function run(command: string[]): CommandResult {
  try {
    const result = Bun.spawnSync({ cmd: command, stdout: "pipe", stderr: "pipe" });
    return {
      success: result.success,
      stdout: result.stdout.toString().trim(),
      stderr: result.stderr.toString().trim(),
    };
  } catch {
    return { success: false, stdout: "", stderr: "" };
  }
}

function debug(message: string): void {
  if (process.env.CODEX_NOTIFY_DEBUG === "1") console.error(`codex-notify debug: ${message}`);
}

export function linuxSessionIsUnlocked(): boolean {
  let sessionId = process.env.XDG_SESSION_ID?.trim() ?? "";
  if (!sessionId) {
    const display = run(["loginctl", "show-user", String(process.getuid?.() ?? ""), "-p", "Display", "--value"]);
    if (!display.success) return false;
    sessionId = display.stdout;
  }
  if (!sessionId) return false;
  const result = run(["loginctl", "show-session", sessionId, "-p", "Active", "-p", "LockedHint"]);
  if (!result.success) return false;
  const properties = new Map(
    result.stdout
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => line.split("=", 2) as [string, string]),
  );
  return properties.get("Active") === "yes" && properties.get("LockedHint") === "no";
}

function activeWindowScriptPath(): string {
  const besideExecutable = join(dirname(process.execPath), "codex-notify-active-window.js");
  if (existsSync(besideExecutable)) return besideExecutable;
  return join(import.meta.dir, "..", "codex-notify-active-window.js");
}

async function withPresenceLock<T>(work: () => Promise<T>): Promise<T | null> {
  const directory = stateDirectory();
  const lock = join(directory, "presence.lock");
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    mkdirSync(lock, { mode: 0o700 });
  } catch {
    return null;
  }
  try {
    return await work();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

export async function queryKdeActiveWindow(): Promise<Record<string, string> | null> {
  return withPresenceLock(async () => {
    const dbus = await import("dbus-next");
    const bus = dbus.sessionBus();
    bus.on("error", () => {
      // A missing desktop session makes the active-window probe unavailable.
    });
    const service = "io.codex.Notify.ActiveWindow";
    const path = "/ActiveWindow";
    const iface = "io.codex.Notify.ActiveWindow";
    const pluginName = `codex-notify-active-window-${process.pid}`;
    let loaded = false;
    try {
      const requestResult = await Promise.race([
        bus.requestName(service, 4),
        Bun.sleep(2_000).then(() => 0),
      ]);
      debug(`D-Bus requestName result: ${requestResult}`);
      if (requestResult !== 1) return null;
      const answer = await new Promise<Record<string, string> | null>((resolve) => {
        let settled = false;
        const finish = (value: Record<string, string> | null) => {
          if (settled) return;
          settled = true;
          resolve(value);
        };
        bus.addMethodHandler((message: any) => {
          if (message.path !== path || message.interface !== iface || message.member !== "Report") {
            return false;
          }
          const [resourceClass = "", caption = "", pid = ""] = message.body ?? [];
          debug(`KWin reported an active window with PID ${String(pid)}`);
          bus.send(dbus.Message.newMethodReturn(message, "", []));
          finish({ resourceClass: String(resourceClass), caption: String(caption), pid: String(pid) });
          return true;
        });
        const load = run([
          "qdbus6",
          "org.kde.KWin",
          "/Scripting",
          "org.kde.kwin.Scripting.loadScript",
          activeWindowScriptPath(),
          pluginName,
        ]);
        loaded = load.success && Number(load.stdout) >= 0;
        debug(`KWin loadScript: success=${load.success} stdout=${load.stdout} stderr=${load.stderr}`);
        if (!loaded) {
          finish(null);
          return;
        }
        const start = run([
          "qdbus6",
          "org.kde.KWin",
          "/Scripting",
          "org.kde.kwin.Scripting.start",
        ]);
        debug(`KWin start: success=${start.success} stderr=${start.stderr}`);
        if (!start.success) finish(null);
        setTimeout(() => finish(null), 2_000).unref();
      });
      return answer;
    } catch (error) {
      debug(`KDE active-window error: ${String(error)}`);
      return null;
    } finally {
      if (loaded) {
        run([
          "qdbus6",
          "org.kde.KWin",
          "/Scripting",
          "org.kde.kwin.Scripting.unloadScript",
          pluginName,
        ]);
      }
      try {
        bus.disconnect();
      } catch {
        // The bus may never have connected.
      }
    }
  });
}

export async function linuxCodexIsActive(): Promise<boolean> {
  const window = await queryKdeActiveWindow();
  if (!window) return false;
  const resourceClass = window.resourceClass?.toLowerCase() ?? "";
  if (["codex", "chatgpt", "chat-gpt"].some((name) => resourceClass.includes(name))) return true;
  if (!/^\d+$/.test(window.pid ?? "")) return false;
  try {
    const processName = readFileSync(`/proc/${window.pid}/comm`, "utf8").trim().toLowerCase();
    return processName === "chatgpt" || processName === "codex";
  } catch {
    return false;
  }
}

export function macIdleSeconds(): number | null {
  try {
    const library = dlopen(
      "/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices",
      {
        CGEventSourceSecondsSinceLastEventType: {
          args: [FFIType.uint32_t, FFIType.uint32_t],
          returns: FFIType.double,
        },
      },
    );
    try {
      const value = library.symbols.CGEventSourceSecondsSinceLastEventType(0, 0xffff_ffff);
      return Number.isFinite(value) && value >= 0 ? value : null;
    } finally {
      library.close();
    }
  } catch {
    return null;
  }
}

export function macSessionIsUnlocked(): boolean {
  const result = run(["ioreg", "-n", "Root", "-d", "1"]);
  return result.success && result.stdout.includes('"IOConsoleLocked" = No');
}

export function macCodexIsActive(): boolean {
  const front = run(["lsappinfo", "front"]);
  if (!front.success || !front.stdout) return false;
  const info = run(["lsappinfo", "info", "-only", "name", front.stdout]);
  if (!info.success) return false;
  const lower = info.stdout.toLowerCase();
  return lower.includes('"chatgpt"') || lower.includes('"codex"');
}

export async function userAcknowledgedCompletion(graceSeconds: number): Promise<boolean> {
  const grace = Math.max(0, graceSeconds);
  if (platform() === "darwin") {
    const started = performance.now();
    await Bun.sleep(grace * 1_000);
    const idle = macIdleSeconds();
    if (idle === null || idle + 0.25 >= (performance.now() - started) / 1_000) return false;
    return macSessionIsUnlocked() && macCodexIsActive();
  }
  if (platform() === "linux") {
    if (!(await linuxActivityAfterCompletion(grace))) return false;
    await Bun.sleep(100);
    return linuxSessionIsUnlocked() && (await linuxCodexIsActive());
  }
  return false;
}

export function notificationText(status: TerminalStatus): { title: string; body: string; tags: string } {
  if (status === "completed") {
    return { title: "Codex task finished", body: "Codex task finished.", tags: "white_check_mark" };
  }
  return { title: "Codex task ended", body: `Codex task ended: ${status}.`, tags: "warning" };
}

export async function sendDestination(
  destination: Destination,
  status: TerminalStatus,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  const { title, body, tags } = notificationText(status);
  try {
    if (destination.type === "ntfy") {
      const response = await fetcher(destination.url, {
        method: "POST",
        body,
        headers: { Title: title, Tags: tags, Cache: "no" },
        signal: AbortSignal.timeout(10_000),
      });
      return response.ok;
    }
    const response = await fetcher(
      `https://api.telegram.org/bot${destination.bot_token}/sendMessage`,
      {
        method: "POST",
        body: JSON.stringify({ chat_id: destination.chat_id, text: `${title}\n${body}` }),
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) return false;
    const result = (await response.json()) as { ok?: unknown };
    return result.ok === true;
  } catch {
    return false;
  }
}

function writeMarker(path: string, outcome: string): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${outcome} ${Math.floor(Date.now() / 1_000)}\n`, { mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
}

async function waitForTerminalStatus(
  threadId: string,
  turnId: string,
  fallbackStatus: TerminalStatus,
  options: Required<Pick<ProcessTurnOptions, "statusReader" | "sleep" | "now" | "maximumWaitMilliseconds">> & {
    historyPath: string;
  },
): Promise<TerminalStatus | null> {
  if (!existsSync(options.historyPath)) return fallbackStatus;
  const deadline = options.now() + options.maximumWaitMilliseconds;
  let turn = options.statusReader(threadId, turnId);
  while (!turn || !TERMINAL_TURN_STATUSES.has(turn.status)) {
    if (options.now() >= deadline) return null;
    await options.sleep(POLL_MILLISECONDS);
    turn = options.statusReader(threadId, turnId);
  }
  return turn.status as TerminalStatus;
}

function acquireTurnLock(path: string, maximumWaitMilliseconds: number): boolean {
  try {
    mkdirSync(path, { mode: 0o700 });
    return true;
  } catch {
    try {
      const age = Date.now() - statSync(path).mtimeMs;
      if (age <= maximumWaitMilliseconds + 60_000) return false;
      rmSync(path, { recursive: true, force: true });
      mkdirSync(path, { mode: 0o700 });
      return true;
    } catch {
      return false;
    }
  }
}

export async function processTurn(
  config: NotifyConfig,
  threadId: string,
  turnId: string,
  fallbackStatus: TerminalStatus = "completed",
  supplied: ProcessTurnOptions = {},
): Promise<string> {
  const directory = supplied.state ?? stateDirectory();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const digest = turnDigest(threadId, turnId);
  const skippedMarker = join(directory, `skipped-${digest}`);
  const maximumWaitMilliseconds = supplied.maximumWaitMilliseconds ?? MAX_WAIT_MILLISECONDS;
  const lock = join(directory, `worker-${digest}.lock`);
  if (!acquireTurnLock(lock, maximumWaitMilliseconds)) return "worker-active";
  try {
    if (existsSync(skippedMarker)) return "duplicate";
    const historyPath = supplied.historyPath ?? historyDatabase();
    const status = await waitForTerminalStatus(threadId, turnId, fallbackStatus, {
      historyPath,
      statusReader: supplied.statusReader ?? ((thread, turn) => readTurnStatus(thread, turn, historyPath)),
      sleep: supplied.sleep ?? Bun.sleep,
      now: supplied.now ?? Date.now,
      maximumWaitMilliseconds,
    });
    if (!status) return "timeout";
    if (config.presence?.enabled) {
      const grace = config.presence.grace_seconds ?? 8;
      const acknowledged = supplied.acknowledgementChecker ?? userAcknowledgedCompletion;
      if (await acknowledged(grace)) {
        writeMarker(skippedMarker, "present");
        return "skipped-present";
      }
    }
    const sender = supplied.sender ?? sendDestination;
    const pending: Array<[Destination, string]> = [];
    const seen = new Set<string>();
    for (const destination of config.destinations) {
      const destinationId = destinationDigest(destination);
      const marker = join(directory, `sent-${digest}-${destinationId}`);
      if (!seen.has(destinationId) && !existsSync(marker)) {
        seen.add(destinationId);
        pending.push([destination, marker]);
      }
    }
    if (pending.length === 0) return "duplicate";
    let failures = 0;
    for (const [destination, marker] of pending) {
      if (await sender(destination, status)) writeMarker(marker, "sent");
      else failures += 1;
    }
    return failures ? "send-failed" : "sent";
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

export function writeWorkerRequest(request: WorkerRequest): string {
  const directory = stateDirectory();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const digest = turnDigest(request.threadId, request.turnId);
  const path = join(directory, `request-${digest}.json`);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(request), { mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
  return digest;
}

export function readWorkerRequest(digest: string): { path: string; request: WorkerRequest } | null {
  const path = join(stateDirectory(), `request-${digest}.json`);
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<WorkerRequest>;
    if (
      typeof value.threadId !== "string" ||
      typeof value.turnId !== "string" ||
      !TERMINAL_TURN_STATUSES.has(value.status ?? "")
    ) {
      return null;
    }
    return { path, request: value as WorkerRequest };
  } catch {
    return null;
  }
}

function isRunningFromSource(): boolean {
  return process.argv[1] === import.meta.path;
}

export function workerCommand(digest: string): string[] {
  return isRunningFromSource()
    ? [process.execPath, import.meta.path, "--worker", digest]
    : [process.execPath, "--worker", digest];
}

export function spawnWorker(request: WorkerRequest): void {
  const digest = writeWorkerRequest(request);
  const subprocess = Bun.spawn({
    cmd: workerCommand(digest),
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  subprocess.unref();
}

export async function checkConfiguration(): Promise<number> {
  try {
    const config = loadConfig();
    console.log(`Configuration OK: ${config.destinations.map(({ type }) => type).join(", ")}`);
    console.log(`Presence suppression: ${config.presence?.enabled ? "enabled" : "disabled"}`);
    return 0;
  } catch (error) {
    console.error(`codex-notify: ${(error as Error).message}`);
    return 1;
  }
}

export async function sendTestNotification(): Promise<number> {
  let config: NotifyConfig;
  try {
    config = loadConfig();
  } catch (error) {
    console.error(`codex-notify: ${(error as Error).message}`);
    return 1;
  }
  let failures = 0;
  for (const destination of config.destinations) {
    if (await sendDestination(destination, "completed")) console.log(`Test sent: ${destination.type}`);
    else {
      console.error(`Test failed: ${destination.type}`);
      failures += 1;
    }
  }
  return failures ? 1 : 0;
}

export async function diagnosePlatform(): Promise<number> {
  console.log(`Platform: ${platform()}`);
  console.log(`Completion database: ${existsSync(historyDatabase()) ? "available" : "hook event fallback"}`);
  if (platform() === "darwin") {
    console.log(`Idle-time API: ${macIdleSeconds() === null ? "unavailable" : "available"}`);
    console.log(`Session unlocked: ${macSessionIsUnlocked() ? "yes" : "no or unavailable"}`);
    console.log(`Codex active: ${macCodexIsActive() ? "yes" : "no or unavailable"}`);
    return 0;
  }
  if (platform() === "linux") {
    let readableInput = false;
    try {
      readableInput = readdirSync("/dev/input")
        .filter((name) => name.startsWith("event"))
        .some((name) => {
          try {
            const descriptor = openSync(join("/dev/input", name), constants.O_RDONLY | constants.O_NONBLOCK);
            closeSync(descriptor);
            return true;
          } catch {
            return false;
          }
        });
    } catch {
      // Keep the fail-safe false value.
    }
    console.log(`Input activity API: ${readableInput ? "available" : "unavailable"}`);
    console.log(`Session unlocked: ${linuxSessionIsUnlocked() ? "yes" : "no or unavailable"}`);
    console.log(`Codex active: ${(await linuxCodexIsActive()) ? "yes" : "no or unavailable"}`);
    return 0;
  }
  console.log("Presence suppression: unsupported platform");
  return 1;
}

function commandLineArguments(): string[] {
  const argumentsAfterExecutable = process.argv.slice(1);
  if (argumentsAfterExecutable[0] === import.meta.path || argumentsAfterExecutable[0] === process.execPath) {
    return argumentsAfterExecutable.slice(1);
  }
  return argumentsAfterExecutable;
}

export async function main(args = commandLineArguments()): Promise<number> {
  if (args.length === 1 && args[0] === "--check") return checkConfiguration();
  if (args.length === 1 && args[0] === "--test") return sendTestNotification();
  if (args.length === 1 && args[0] === "--diagnose") return diagnosePlatform();
  if (args.length === 2 && args[0] === "--worker") {
    const loaded = readWorkerRequest(args[1]!);
    if (!loaded) return 1;
    let config: NotifyConfig;
    try {
      config = loadConfig();
    } catch {
      return 1;
    }
    const outcome = await processTurn(
      config,
      loaded.request.threadId,
      loaded.request.turnId,
      loaded.request.status,
    );
    if (["sent", "skipped-present", "duplicate"].includes(outcome)) {
      try {
        unlinkSync(loaded.path);
      } catch {
        // Another duplicate worker already removed it.
      }
    }
    return outcome === "send-failed" ? 1 : 0;
  }
  if (args.length !== 1) return 2;
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(args[0]!) as Record<string, unknown>;
  } catch {
    return 2;
  }
  if (event.type !== "agent-turn-complete") return 0;
  if (typeof event["thread-id"] !== "string" || typeof event["turn-id"] !== "string") return 0;
  const status = TERMINAL_TURN_STATUSES.has(String(event.status))
    ? (event.status as TerminalStatus)
    : "completed";
  spawnWorker({ threadId: event["thread-id"], turnId: event["turn-id"], status });
  return 0;
}

if (import.meta.main) {
  process.exitCode = await main();
}
