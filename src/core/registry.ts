import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FlowError } from "./errors.js";
import { renameWithRetry } from "./fsutil.js";
import { FLOW_DIRNAME } from "./paths.js";

/**
 * The user-level list of agent-flow workspaces on this machine. Each project keeps its own `.agent-flow/` database
 * and its own MCP server; the registry only tells the single dashboard hub (`agent-flow serve`) which projects exist.
 *
 * Location: `AGENT_FLOW_REGISTRY` (a file path), else `~/.agent-flow/workspaces.json`. `AGENT_FLOW_REGISTRY=off`
 * disables it: reads return nothing and registration is a no-op.
 */
export interface RegistryEntry {
  /** URL-safe, stable id: the folder name, plus a short hash when two projects share a folder name. */
  id: string;
  name: string;
  root: string;
  added_at: string;
}

interface RegistryFile {
  version: 1;
  workspaces: RegistryEntry[];
}

export function registryPath(): string | null {
  const env = process.env.AGENT_FLOW_REGISTRY;
  if (env && env.toLowerCase() === "off") return null;
  return env ? path.resolve(env) : path.join(os.homedir(), FLOW_DIRNAME, "workspaces.json");
}

/** Canonical form of a project root, so junctions, symlinks and drive-letter case count once. */
export function canonicalRoot(root: string): string {
  const abs = path.resolve(root);
  try {
    return realpathSync.native(abs);
  } catch {
    return abs;
  }
}

/** Comparison key for two roots: case-insensitive on Windows. */
export const rootKey = (root: string) => (process.platform === "win32" ? canonicalRoot(root).toLowerCase() : canonicalRoot(root));
const sameRoot = (a: string, b: string) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);

/** The bearer token file of the hub: next to the registry, so every project's dashboard shares one. */
export function hubTokenFile(file: string): string {
  return path.join(path.dirname(file), "serve.json");
}

export function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "")
      .slice(0, 48) || "workspace"
  );
}

export function readRegistry(file: string | null = registryPath()): RegistryEntry[] {
  if (!file || !existsSync(file)) return [];
  try {
    const data = JSON.parse(readFileSync(file, "utf8")) as Partial<RegistryFile>;
    return Array.isArray(data.workspaces)
      ? data.workspaces.filter((w): w is RegistryEntry => !!w && typeof w.id === "string" && typeof w.root === "string")
      : [];
  } catch {
    // A torn or hand-broken file reads as empty rather than taking the dashboard down; the next write repairs it.
    return [];
  }
}

function writeRegistry(file: string, workspaces: RegistryEntry[]): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, workspaces } satisfies RegistryFile, null, 2)}\n`);
  try {
    renameWithRetry(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

export function findEntry(entries: RegistryEntry[], idOrRoot: string): RegistryEntry | undefined {
  const byId = entries.find((e) => e.id === idOrRoot);
  if (byId) return byId;
  const root = canonicalRoot(idOrRoot);
  return entries.find((e) => sameRoot(e.root, root));
}

/** Add `root` to the registry. Idempotent: an already-registered root returns its entry and writes nothing. */
export function registerWorkspace(root: string, file: string | null = registryPath()): { entry: RegistryEntry; added: boolean } | null {
  if (!file) return null;
  const canonical = canonicalRoot(root);
  if (!existsSync(path.join(canonical, FLOW_DIRNAME, "config.json"))) {
    throw new FlowError("NOT_INITIALIZED", `no ${FLOW_DIRNAME}/ in ${canonical}`, { nextSteps: [`agent-flow init -C ${canonical}`] });
  }
  const entries = readRegistry(file);
  const existing = entries.find((e) => sameRoot(e.root, canonical));
  if (existing) return { entry: existing, added: false };
  const name = path.basename(canonical) || canonical;
  let id = slug(name);
  if (entries.some((e) => e.id === id)) {
    id = `${id}-${createHash("sha1").update(canonical.toLowerCase()).digest("hex").slice(0, 6)}`;
  }
  const entry: RegistryEntry = { id, name, root: canonical, added_at: new Date().toISOString() };
  writeRegistry(file, [...entries, entry]);
  return { entry, added: true };
}

/** Register without letting a registry problem break the caller (init, mcp, serve). */
export function registerQuietly(root: string): RegistryEntry | null {
  try {
    return registerWorkspace(root)?.entry ?? null;
  } catch {
    return null;
  }
}

export function unregisterWorkspace(idOrRoot: string, file: string | null = registryPath()): RegistryEntry | null {
  if (!file) return null;
  const entries = readRegistry(file);
  const hit = findEntry(entries, idOrRoot);
  if (!hit) return null;
  writeRegistry(
    file,
    entries.filter((e) => e !== hit),
  );
  return hit;
}

/** Direct children of `root` that hold an initialized `.agent-flow/` (the same rule `agent-flow adoption` uses). */
export function scanForWorkspaces(root: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const dir = path.join(root, entry.name);
    if (!existsSync(path.join(dir, FLOW_DIRNAME, "config.json"))) continue;
    const real = canonicalRoot(dir);
    const key = process.platform === "win32" ? real.toLowerCase() : real;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(real);
  }
  return out;
}

export function workspaceAvailable(root: string): boolean {
  return existsSync(path.join(root, FLOW_DIRNAME, "config.json"));
}
