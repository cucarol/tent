import { spawn } from "node:child_process";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { defaultWorkspacesFile } from "../ui-server/workspaces.js";
import { resolveWorkspacePaths } from "./workspace-path.js";

export const uiHelpText = `Usage: tent ui [--workspace <path>] [--port <number>] [--no-open]

Start the local Web UI in the foreground. Ctrl+C closes its server.
  --workspace <path>   Select an existing Tent workspace.
  --port <number>      Override the workspace's default port (0 selects a free port).
  --no-open            Print the URL without opening a browser.
  -h, --help           Show this help.
`;

type StartUiServer = (options: {
  workspaceRoot: string;
  port?: number;
  staticDir: string;
  workspacesFile?: string;
}) => Promise<{ url: string; portTaken?: number; close(): Promise<void> }>;

/** CLI composition supplies the service; workspace and document rules stay outside this entry. */
export async function runUiCommand(
  args: string[],
  options: { packageRoot: string; startServer: StartUiServer },
) {
  const { values } = parseArgs({
    args,
    options: {
      workspace: { type: "string" },
      port: { type: "string" },
      "no-open": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    process.stdout.write(uiHelpText);
    return;
  }
  const port = values.port === undefined ? undefined : Number(values.port);
  if (
    values.port !== undefined &&
    (!/^\d+$/.test(values.port) || !Number.isSafeInteger(port) || port! < 0 || port! > 65535)
  )
    throw new Error("--port must be an integer between 0 and 65535");
  const { workspaceRoot } = await resolveWorkspacePaths({ workspace: values.workspace });
  const server = await options.startServer({
    workspaceRoot,
    port,
    staticDir: path.join(options.packageRoot, "ui-dist"),
    workspacesFile: defaultWorkspacesFile(),
  });
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      try {
        await server.close();
      } finally {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
      }
    })());
  const stop = () => {
    void close().catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  process.stdout.write(`${server.url}\n`);
  if (server.portTaken !== undefined)
    console.error(
      `Workspace port ${server.portTaken} is busy; using the URL above. Browser preferences for the usual address are unavailable on this temporary port.`,
    );
  if (!values["no-open"])
    await openBrowser(server.url).catch((error) => {
      console.error(
        `Could not open the browser; use the URL above. ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  return { url: server.url, close };
}

async function openBrowser(url: string): Promise<void> {
  const [command, args] =
    process.platform === "win32"
      ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`Browser opener exited with ${code}`)),
    );
  });
}
