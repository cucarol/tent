import { FsAdapter } from "./adapter.js";

export async function backupCorruptRegistry(fs: FsAdapter, path: string): Promise<string> {
  const backupPath = `${path}.corrupt-${timestamp()}`;
  await fs.writeFile(backupPath, await fs.readFile(path));
  return backupPath;
}

export function warnRegistryRecovered(
  path: string,
  backupPath: string,
  action: "recovered" | "reset",
  extra = "",
): void {
  console.error(
    `WARNING: ${path} was corrupt; backed up to ${backupPath} and ${action}. Review it.${extra ? ` ${extra}` : ""}`,
  );
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}
