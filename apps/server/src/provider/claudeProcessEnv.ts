// FILE: claudeProcessEnv.ts
// Purpose: Builds Claude subprocess environments that prefer valid local Claude CLI OAuth.
// Layer: Provider utility shared by Claude runtime sessions and provider health probes.
// Exports: Claude credentials parsing, path resolution, and env sanitization helpers.
import { existsSync, readFileSync } from "node:fs";
import OS from "node:os";
import nodePath from "node:path";

const CLAUDE_DIRECT_CREDENTIAL_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
] as const;

const CLAUDE_EXTERNAL_AUTH_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
] as const;

function trimToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function envFlagEnabled(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return Boolean(normalized && normalized !== "0" && normalized !== "false");
}

function hasClaudeExternalAuthEnv(env: NodeJS.ProcessEnv): boolean {
  return CLAUDE_EXTERNAL_AUTH_ENV_KEYS.some((key) => envFlagEnabled(env[key]));
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function tryParseJsonRecord(content: string): Record<string, unknown> | undefined {
  try {
    return readRecord(JSON.parse(content));
  } catch {
    return undefined;
  }
}

export interface ClaudeCliCredentialsSummary {
  readonly usable: boolean;
  readonly subscriptionType?: string;
}

export function resolveClaudeCredentialsPaths(input?: {
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
}): ReadonlyArray<string> {
  const env = input?.env ?? process.env;
  const homeDir = trimToUndefined(input?.homeDir) ?? trimToUndefined(env.HOME) ?? OS.homedir();
  const paths: string[] = [];
  const configDir = trimToUndefined(env.CLAUDE_CONFIG_DIR);
  if (configDir) {
    paths.push(nodePath.join(configDir, ".credentials.json"));
  }
  paths.push(nodePath.join(homeDir, ".claude", ".credentials.json"));
  return [...new Set(paths)];
}

export function hasUsableClaudeCliCredentialsContent(content: string, nowMs = Date.now()): boolean {
  return readClaudeCliCredentialsContentSummary(content, nowMs).usable;
}

export function readClaudeCliCredentialsContentSummary(
  content: string,
  nowMs = Date.now(),
): ClaudeCliCredentialsSummary {
  const root = tryParseJsonRecord(content);
  const oauth = readRecord(root?.claudeAiOauth);
  const accessToken = readNonEmptyString(oauth?.accessToken);
  const refreshToken = readNonEmptyString(oauth?.refreshToken);
  if (!accessToken && !refreshToken) {
    return { usable: false };
  }

  const expiresAtMs = typeof oauth?.expiresAt === "number" ? oauth.expiresAt : undefined;
  const usable = expiresAtMs === undefined || expiresAtMs > nowMs || refreshToken !== undefined;
  const subscriptionType = readNonEmptyString(oauth?.subscriptionType);
  return {
    usable,
    ...(subscriptionType ? { subscriptionType } : {}),
  };
}

export function hasUsableClaudeCliCredentials(input?: {
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
  readonly nowMs?: number;
  readonly readFile?: (path: string) => string;
}): boolean {
  return readClaudeCliCredentialsSummary(input).usable;
}

export function readClaudeCliCredentialsSummary(input?: {
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
  readonly nowMs?: number;
  readonly readFile?: (path: string) => string;
}): ClaudeCliCredentialsSummary {
  const readFile = input?.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  for (const path of resolveClaudeCredentialsPaths(input)) {
    try {
      const summary = readClaudeCliCredentialsContentSummary(readFile(path), input?.nowMs);
      if (summary.usable) {
        return summary;
      }
    } catch {
      continue;
    }
  }
  return { usable: false };
}

export function buildClaudeProcessEnv(input?: {
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
  readonly hasClaudeCliCredentials?: boolean;
}): NodeJS.ProcessEnv {
  const env = { ...(input?.env ?? process.env) };
  if (input?.homeDir) {
    env.HOME = input.homeDir;
  }
  const credentialInput = input?.homeDir ? { env, homeDir: input.homeDir } : { env };
  const hasLocalClaudeAuth =
    input?.hasClaudeCliCredentials ?? hasUsableClaudeCliCredentials(credentialInput);

  if (!hasLocalClaudeAuth || hasClaudeExternalAuthEnv(env)) {
    return env;
  }

  // Claude gives direct request credentials precedence over local OAuth. Drop stale
  // app-process keys when a real Claude CLI login can satisfy the subprocess.
  for (const key of CLAUDE_DIRECT_CREDENTIAL_ENV_KEYS) {
    delete env[key];
  }
  return env;
}

// Known absolute directories that hold the Claude Code CLI on POSIX platforms, ordered
// from most to least specific. The native installer symlinks `~/.local/bin/claude`; older
// installs live under `~/.claude/local`; Homebrew and manual installs use the usual bins.
function knownPosixClaudeExecutableDirs(homeDir: string): ReadonlyArray<string> {
  return [
    nodePath.join(homeDir, ".local", "bin"),
    nodePath.join(homeDir, ".claude", "local"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
  ];
}

function defaultClaudeExecutableExists(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

/**
 * Resolves the Claude Code CLI to an absolute path so the SDK subprocess does not depend
 * on the host process's `PATH`. A GUI/desktop launch (macOS Dock/launchd) inherits a
 * minimal `PATH` that omits `~/.local/bin`, so spawning the bare name `"claude"` fails with
 * ENOENT ("native binary not found at claude") even though the CLI works in a terminal.
 *
 * Resolution order:
 *  1. An explicitly configured `binaryPath` is honored verbatim (the user's override).
 *  2. The first `claude` found on the subprocess `PATH` (mirrors terminal resolution order).
 *  3. The first `claude` found in a known install location (covers an un-hydrated `PATH`).
 *  4. The bare name `"claude"` as a last resort (lets the OS/SDK resolve it, preserving the
 *     prior behavior when nothing else matched).
 *
 * Windows is intentionally left to OS/`PATHEXT` resolution: `claude` is commonly a
 * `.cmd`/`.ps1` shim that must launch through the shell, so returning an absolute path to it
 * could break `spawn()`.
 */
export function resolveClaudeExecutablePath(input?: {
  readonly binaryPath?: string | null | undefined;
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
  readonly platform?: NodeJS.Platform;
  readonly fileExists?: (path: string) => boolean;
}): string {
  const configured = trimToUndefined(input?.binaryPath ?? undefined);
  if (configured) {
    return configured;
  }

  const platform = input?.platform ?? process.platform;
  if (platform === "win32") {
    return "claude";
  }

  const env = input?.env ?? process.env;
  const fileExists = input?.fileExists ?? defaultClaudeExecutableExists;
  // Use the real OS home rather than a Synara profile home override: the CLI is installed
  // under the user's account, not the app's data directory.
  const homeDir = trimToUndefined(input?.homeDir) ?? OS.homedir();

  for (const dir of (env.PATH ?? "").split(nodePath.delimiter)) {
    const entry = dir.trim();
    if (!entry) {
      continue;
    }
    const candidate = nodePath.join(entry, "claude");
    if (fileExists(candidate)) {
      return candidate;
    }
  }

  for (const dir of knownPosixClaudeExecutableDirs(homeDir)) {
    const candidate = nodePath.join(dir, "claude");
    if (fileExists(candidate)) {
      return candidate;
    }
  }

  return "claude";
}
