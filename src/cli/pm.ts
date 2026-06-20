/**
 * Package-manager detection, project package.json reading, and dependency
 * install for the `@svelte-plugin/font` setup CLI.
 *
 * Self-contained: uses only node builtins (node:fs, node:path,
 * node:child_process). No third-party imports — keeps the bin's runtime
 * surface minimal and avoids pulling clack/magicast into this module.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

/** Lockfile -> package manager, checked in this order. */
const LOCKFILES: Array<{ file: string; pm: PackageManager }> = [
  { file: "bun.lockb", pm: "bun" },
  { file: "bun.lock", pm: "bun" },
  { file: "pnpm-lock.yaml", pm: "pnpm" },
  { file: "yarn.lock", pm: "yarn" },
  { file: "package-lock.json", pm: "npm" },
];

/**
 * Detect the project's package manager.
 *
 * Inspects lockfiles in `cwd` (bun.lockb|bun.lock -> bun; pnpm-lock.yaml ->
 * pnpm; yarn.lock -> yarn; package-lock.json -> npm). Falls back to the
 * `npm_config_user_agent` env signal (set when the CLI is itself run through a
 * package manager). Returns null when nothing matches — the caller defaults the
 * prompt to 'npm'.
 */
export function detectPackageManager(cwd: string): PackageManager | null {
  for (const { file, pm } of LOCKFILES) {
    if (existsSync(join(cwd, file))) return pm;
  }

  const ua = process.env.npm_config_user_agent;
  if (ua) {
    const name = ua.split("/")[0];
    if (name === "pnpm" || name === "yarn" || name === "bun" || name === "npm") {
      return name;
    }
  }

  return null;
}

/**
 * Read and parse `<cwd>/package.json`. Returns the parsed json plus its
 * absolute path, or null when the file is missing or unreadable/invalid.
 */
export function readProjectPkg(cwd: string): { json: any; path: string } | null {
  const path = join(cwd, "package.json");
  if (!existsSync(path)) return null;
  try {
    const json = JSON.parse(readFileSync(path, "utf8"));
    return { json, path };
  } catch {
    return null;
  }
}

/**
 * True if `name` appears in dependencies, devDependencies, or
 * peerDependencies of the given parsed package.json. Used to skip the install
 * step when `@svelte-plugin/font` is already present.
 */
export function hasDep(pkg: any, name: string): boolean {
  if (!pkg || typeof pkg !== "object") return false;
  return Boolean(
    pkg.dependencies?.[name] ??
      pkg.devDependencies?.[name] ??
      pkg.peerDependencies?.[name],
  );
}

/**
 * True if `pkg` is listed as a dependency in `<cwd>/package.json`.
 * Convenience wrapper over readProjectPkg + hasDep.
 */
export function isInstalled(cwd: string, pkg: string): boolean {
  const info = readProjectPkg(cwd);
  return info ? hasDep(info.json, pkg) : false;
}

/**
 * Build the argv (sans the executable) for installing `pkg` with `pm`.
 *
 *   npm  -> ['install', '-D' | '--save', pkg]
 *   pnpm -> ['add', '-D'?, pkg]
 *   yarn -> ['add', '--dev'?, pkg]
 *   bun  -> ['add', '-d'?, pkg]
 *
 * Empty flags are filtered out so the resulting argv is always clean.
 */
export function installCommand(
  pm: PackageManager,
  pkg: string,
  dev: boolean,
): string[] {
  switch (pm) {
    case "npm":
      return ["install", dev ? "-D" : "--save", pkg];
    case "pnpm":
      return ["add", dev ? "-D" : "", pkg].filter(Boolean);
    case "yarn":
      return ["add", dev ? "--dev" : "", pkg].filter(Boolean);
    case "bun":
      return ["add", dev ? "-d" : "", pkg].filter(Boolean);
    default:
      // Unknown PM (the flag parser validates, but stay defensive): fall back to
      // npm-style args so callers always get a usable argv.
      return ["install", dev ? "-D" : "--save", pkg];
  }
}

/** Argv for installing `pkg` as a devDependency with `pm`. */
export function installDevArgs(pm: PackageManager, pkg: string): string[] {
  return installCommand(pm, pkg, true);
}

/** Human-readable command string, e.g. "npm install -D @svelte-plugin/font". */
export function formatCommand(pm: PackageManager, argv: string[]): string {
  return [pm, ...argv].join(" ");
}

/**
 * The one place that actually spawns a package manager. Both public install
 * entry points funnel through here so the Windows + error handling only lives
 * once.
 *
 * On Windows, npm/pnpm/yarn/bun resolve to .cmd/.ps1 shims that spawnSync
 * cannot launch directly (ENOENT), so `shell: true` is required there. The
 * command is a fixed PM name and our own argv (a known scoped pkg name), so the
 * shell-interpolation surface is safe.
 */
function spawnInstall(
  pm: PackageManager,
  argv: string[],
  cwd: string,
): { ok: boolean; status: number | null; error?: Error } {
  const result = spawnSync(pm, argv, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  return {
    ok: !result.error && result.status === 0,
    status: result.status,
    error: result.error ?? undefined,
  };
}

/**
 * Install `pkg` as a devDependency with `pm` in `cwd`.
 *
 * When `dryRun` is set, nothing is spawned: returns { ran:false, command,
 * ok:true } so the caller can print the command for the user to run. Otherwise
 * spawns the package manager with inherited stdio and reports the outcome.
 * `reason` carries the spawn error (e.g. ENOENT — PM not installed) so the
 * caller can distinguish "install failed" from "pnpm not found".
 */
export function installDevDep(args: {
  pm: PackageManager;
  pkg: string;
  cwd: string;
  dryRun: boolean;
}): { ran: boolean; command: string; ok: boolean; reason?: string } {
  const argv = installCommand(args.pm, args.pkg, true);
  const command = formatCommand(args.pm, argv);

  if (args.dryRun) {
    return { ran: false, command, ok: true };
  }

  const r = spawnInstall(args.pm, argv, args.cwd);
  return {
    ran: true,
    command,
    ok: r.ok,
    reason: r.error
      ? `${r.error.message} (is ${args.pm} installed?)`
      : r.ok
        ? undefined
        : `${command} exited with code ${r.status}`,
  };
}

/**
 * Spawn `pm` to install `pkg` as a devDependency in `cwd`, inheriting stdio.
 * Resolves on a clean exit (status 0), throws otherwise. Convenience wrapper for
 * callers that prefer throw-on-failure over the result object.
 */
export function runInstall(args: {
  pm: PackageManager;
  pkg: string;
  cwd: string;
}): void {
  const argv = installDevArgs(args.pm, args.pkg);
  const r = spawnInstall(args.pm, argv, args.cwd);
  if (r.error) throw r.error;
  if (!r.ok) {
    throw new Error(`${formatCommand(args.pm, argv)} exited with code ${r.status}`);
  }
}

// NOTE: no inline direct-run self-check here. esbuild bundles this module into
// dist/cli.js, where an `import.meta.url === file://process.argv[1]` guard would
// fire on every `npx @svelte-plugin/font` run. The self-check lives in the
// standalone src/cli/pm.selfcheck.ts (never imported by index.ts, never an
// esbuild entry).
