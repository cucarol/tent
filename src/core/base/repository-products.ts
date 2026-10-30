import path from "node:path";
import type { RepositorySource } from "./repository-imports.js";

const isPluginManifest = (file: string) =>
  file === ".claude-plugin/plugin.json" || file === ".codex-plugin/plugin.json";
export const isProductManifest = (file: string) =>
  path.posix.basename(file) === "package.json" || isPluginManifest(file);

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as ObjectValue)
    : {};
const json = (source: RepositorySource): ObjectValue => {
  try {
    return object(JSON.parse(source.content ?? ""));
  } catch {
    return {};
  }
};
const strings = (value: unknown): string[] =>
  typeof value === "string" ? [value] : Array.isArray(value) ? value.flatMap(strings) : [];
const exportPaths = (value: unknown): string[] =>
  typeof value === "string"
    ? [value]
    : Array.isArray(value)
      ? value.flatMap(exportPaths)
      : Object.values(object(value)).flatMap(exportPaths);

/** Product evidence is separate from parseable code and never reads component bodies. */
export function repositoryProductMaterials(sources: readonly RepositorySource[]) {
  const files = new Set(sources.map((source) => source.path));
  const candidates = new Set<string>();
  const add = (value: string, base = ".") => {
    // Only literal local addresses: no expansion, external roots, globs or traversal.
    if (
      !value ||
      /[\\:*?#[\]{}\x00-\x1f$]/.test(value) ||
      value.startsWith("/") ||
      value.split("/").includes("..")
    )
      return;
    const local = path.posix.join(base, value);
    if (local !== ".") candidates.add(local.replace(/\/$/, ""));
  };
  const component = (value: unknown) => {
    for (const item of strings(value)) if (item.startsWith("./")) add(item);
  };
  for (const source of sources) {
    if (!isProductManifest(source.path)) continue;
    const manifest = json(source);
    if (path.posix.basename(source.path) === "package.json") {
      const base = path.posix.dirname(source.path);
      for (const item of [
        ...strings(manifest.bin),
        ...Object.values(object(manifest.bin)).flatMap(strings),
        ...strings(manifest.main),
        ...exportPaths(manifest.exports),
      ])
        add(item, base);
    }
    if (!isPluginManifest(source.path)) continue;
    add(source.path);
    if (source.path === ".claude-plugin/plugin.json") {
      for (const item of [
        "skills/",
        "commands/",
        "agents/",
        "hooks/hooks.json",
        ".mcp.json",
        ".lsp.json",
        "output-styles/",
        "workflows/",
        "themes/",
        "monitors/monitors.json",
        "bin/",
        "settings.json",
        "SKILL.md",
      ])
        add(item);
      for (const key of [
        "skills",
        "commands",
        "agents",
        "hooks",
        "mcpServers",
        "lspServers",
        "outputStyles",
        "workflows",
        "themes",
      ])
        component(manifest[key]);
      const experimental = object(manifest.experimental);
      component(experimental.themes);
      component(experimental.monitors);
      for (const command of Object.values(object(manifest.commands)))
        component(object(command).source);
    } else {
      for (const item of ["skills/", "hooks/hooks.json", ".mcp.json", ".app.json", "assets/"])
        add(item);
      for (const key of ["skills", "hooks", "mcpServers", "apps"]) component(manifest[key]);
      const display = object(manifest.interface);
      for (const key of ["composerIcon", "logo", "screenshots"]) component(display[key]);
    }
  }
  const materials = new Map<string, { path: string; kind: "file" | "directory" }>();
  for (const candidate of candidates) {
    const folder = files.has(candidate) ? path.posix.dirname(candidate) : candidate;
    if (folder !== "." && [...files].some((file) => file.startsWith(folder + "/")))
      materials.set(folder, { path: folder, kind: "directory" });
    else if (files.has(candidate)) materials.set(candidate, { path: candidate, kind: "file" });
  }
  return [...materials.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
