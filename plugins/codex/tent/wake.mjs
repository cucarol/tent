// Binds a Codex chat to a Tent Role: queues a message into the chat when the Role's Cards
// arrive, and lets other sessions queue a word for the chats bound to a Role.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const usage =
  "Usage: node wake.mjs --role <role-id> [--workspace <root>] [--include-open] [--thread <id>] [--codex <path>] [--stop]\n" +
  "       node wake.mjs --tell <role-id> --from <role-id> --message <text>|- [--workspace <root>] [--codex <path>]";
const cli = fileURLToPath(new URL("./cli.mjs", import.meta.url));
const self = fileURLToPath(import.meta.url);

const options = { workspace: process.cwd(), thread: process.env.CODEX_THREAD_ID, seen: "" };
const flags = new Set();
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index++) {
  const name = args[index].replace(/^--/, "");
  if (["include-open", "stop", "run"].includes(name)) flags.add(name);
  else if (
    ["role", "workspace", "thread", "codex", "seen", "tell", "from", "message"].includes(name) &&
    index + 1 < args.length
  )
    options[name] = args[++index];
  else fail(usage);
}
const workspace = path.resolve(options.workspace);
// Inside the Workspace, so sandboxed chats and other hosts' sessions see the same bindings.
const bindings = path.join(workspace, ".tent", "temp", "role-chats");
const cardId = (line) => line.match(/\bcard-[a-z0-9]+\b/)?.[0] ?? line;

if (options.tell) tell();
else {
  if (!options.role) fail(usage);
  if (!options.thread)
    fail("No Codex thread id: run this from a Codex chat, or pass --thread <id>.");
  const key = createHash("sha256")
    .update(`${options.role}\n${options.thread}`)
    .digest("hex")
    .slice(0, 16);
  const binding = path.join(bindings, `${key}.json`);
  const log = path.join(bindings, `${key}.log`);
  if (flags.has("run")) await run(binding, log);
  else start(binding);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/** A binding whose process still runs; dead ones bind nothing. */
function readBinding(file) {
  try {
    const entry = JSON.parse(fs.readFileSync(file, "utf8"));
    return alive(entry.pid) ? entry : undefined;
  } catch {
    return undefined;
  }
}

/** The Desktop app's bundled CLI on Windows, else `codex` on PATH. */
function codex() {
  if (options.codex) return options.codex;
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    const bin = path.join(process.env.LOCALAPPDATA, "OpenAI", "Codex", "bin");
    const found = (fs.existsSync(bin) ? fs.readdirSync(bin) : [])
      .map((name) => path.join(bin, name, "codex.exe"))
      .filter((file) => fs.existsSync(file))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    if (found.length) return found[0];
  }
  return "codex";
}

function queue(thread, message) {
  return spawnSync(codex(), ["queue", "--thread", thread, "--message", message], {
    encoding: "utf8",
    windowsHide: true,
  });
}

function watch(once) {
  const result = spawnSync(
    process.execPath,
    [
      cli,
      "card",
      "watch",
      "--role",
      options.role,
      "--workspace",
      workspace,
      ...(flags.has("include-open") ? ["--include-open"] : []),
      ...(once ? ["--timeout", "0"] : []),
    ],
    { encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
  );
  if (result.status === 2) return { lines: [] };
  if (result.status !== 0) return { error: result.stderr || String(result.error ?? result.status) };
  return { lines: result.stdout.split(/\r?\n/).filter(Boolean) };
}

/** Queues a word into every live chat bound to the Role in this Workspace. */
function tell() {
  const text = options.message === "-" ? fs.readFileSync(0, "utf8") : options.message;
  if (!text?.trim() || !options.from) fail(usage);
  const chats = (fs.existsSync(bindings) ? fs.readdirSync(bindings) : [])
    .filter((name) => name.endsWith(".json"))
    .map((name) => readBinding(path.join(bindings, name)))
    .filter((entry) => entry && entry.role === options.tell);
  if (!chats.length)
    fail(
      `No Codex chat is bound to ${options.tell} in this Workspace; a chat binds when it starts as the Role.`,
    );
  for (const chat of chats) {
    const queued = queue(
      chat.thread,
      `Tent: a message for ${options.tell} from ${options.from}:\n${text.trimEnd()}`,
    );
    if (queued.status !== 0)
      fail(`codex queue failed: ${(queued.stderr || String(queued.error)).trimEnd()}`);
  }
  process.stdout.write(`Told ${options.tell} in ${chats.length} chat(s).\n`);
}

function start(binding) {
  const pid = readBinding(binding)?.pid;
  if (flags.has("stop")) {
    if (pid) process.kill(pid);
    fs.rmSync(binding, { force: true });
    process.stdout.write(
      pid
        ? `Unbound this chat from ${options.role}.\n`
        : `This chat is not bound to ${options.role}.\n`,
    );
    return;
  }
  if (pid) {
    process.stdout.write(`Already bound this chat to ${options.role} (pid ${pid}).\n`);
    return;
  }
  const probe = spawnSync(codex(), ["queue", "--help"], { windowsHide: true });
  if (probe.status !== 0) fail("Codex CLI with `queue` not found: pass --codex <path to codex>.");
  const now = watch(true);
  if (now.error) fail(now.error.trimEnd());
  const child = spawn(
    process.execPath,
    [self, ...args, "--thread", options.thread, "--run", "--seen", now.lines.map(cardId).join(",")],
    { detached: true, stdio: "ignore", windowsHide: true },
  );
  child.unref();
  fs.mkdirSync(bindings, { recursive: true });
  fs.writeFileSync(
    binding,
    JSON.stringify({ pid: child.pid, role: options.role, thread: options.thread }),
  );
  process.stdout.write(
    `Bound this chat to ${options.role}; its Cards and messages arrive here (pid ${child.pid}).\n` +
      now.lines.map((line) => `${line}\n`).join(""),
  );
}

async function run(binding, logFile) {
  const log = (text) => fs.appendFileSync(logFile, `${new Date().toISOString()} ${text}\n`);
  process.on("exit", () => {
    if (readBinding(binding)?.pid === process.pid) fs.rmSync(binding, { force: true });
  });
  let told = new Set(options.seen.split(",").filter(Boolean));
  let failures = 0;
  for (;;) {
    // With nothing waiting, block until a Card comes; otherwise check again shortly.
    const now = watch(told.size > 0);
    if (now.error) {
      log(now.error.trimEnd());
      if (++failures >= 10) process.exit(1);
      await new Promise((resolve) => setTimeout(resolve, 30_000));
      continue;
    }
    failures = 0;
    const ids = now.lines.map(cardId);
    const fresh = now.lines.filter((line) => !told.has(cardId(line)));
    told = new Set(ids.filter((id) => told.has(id)));
    if (fresh.length) {
      const queued = queue(
        options.thread,
        `Tent: Cards for ${options.role}:\n${fresh.join("\n")}\nTake the first Card.`,
      );
      if (queued.status !== 0) {
        log(`codex queue failed: ${queued.stderr || queued.error}`);
        process.exit(1);
      }
      for (const line of fresh) told.add(cardId(line));
    }
    if (told.size) await new Promise((resolve) => setTimeout(resolve, 15_000));
  }
}
