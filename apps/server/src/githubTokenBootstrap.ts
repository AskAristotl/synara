/**
 * GitHub token bootstrap.
 *
 * Provider sessions run their tools in sandboxes that cannot unlock the macOS
 * keychain, so `gh` inside a run has no credentials and PR creation fails —
 * even though the user is logged in. This server process DOES run in the
 * user's session, so it can read the token once at boot via `gh auth token`
 * and export it on `process.env`; every provider env builder spreads
 * `process.env`, so the token rides into each session from then on.
 *
 * - An explicit GH_TOKEN / GITHUB_TOKEN in the environment always wins.
 * - `T3CODE_GH_USER` picks the `gh` account (multi-account setups).
 * - `T3CODE_GH_TOKEN_BOOTSTRAP=0` disables the lookup entirely.
 * - Failure (no gh, not logged in) is non-fatal: one log line, no token.
 */

import { execFile } from "node:child_process";

const EXEC_TIMEOUT_MS = 5_000;

export interface GithubTokenBootstrapInput {
  readonly env?: NodeJS.ProcessEnv;
  readonly log?: (message: string) => void;
  readonly execFileImpl?: typeof execFile;
}

/** Resolves to true when a token is present afterwards (existing or fetched). */
export async function bootstrapGithubToken(
  input: GithubTokenBootstrapInput = {},
): Promise<boolean> {
  const env = input.env ?? process.env;
  const log = input.log ?? (() => {});
  if (env.T3CODE_GH_TOKEN_BOOTSTRAP === "0") {
    return Boolean(env.GH_TOKEN?.trim() ?? env.GITHUB_TOKEN?.trim());
  }
  if (env.GH_TOKEN?.trim() || env.GITHUB_TOKEN?.trim()) {
    return true;
  }
  const user = env.T3CODE_GH_USER?.trim();
  const args = ["auth", "token", ...(user ? ["--user", user] : [])];
  const exec = input.execFileImpl ?? execFile;
  const token = await new Promise<string | undefined>((resolve) => {
    exec(
      "gh",
      args,
      { timeout: EXEC_TIMEOUT_MS },
      (error: Error | null, stdout: string | Buffer) => {
        if (error) {
          resolve(undefined);
          return;
        }
        const value = stdout.toString().trim();
        resolve(value === "" ? undefined : value);
      },
    );
  });
  if (token === undefined) {
    log(
      `gh token bootstrap: no token resolved (gh missing or not logged in${user ? ` for --user ${user}` : ""}); PR creation inside runs may fail until GH_TOKEN is exported`,
    );
    return false;
  }
  env.GH_TOKEN = token;
  if (!env.GITHUB_TOKEN?.trim()) {
    env.GITHUB_TOKEN = token;
  }
  log(
    `gh token bootstrap: GH_TOKEN resolved from gh CLI${user ? ` (--user ${user})` : ""} and exported to provider sessions`,
  );
  return true;
}
