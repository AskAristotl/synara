import { describe, expect, it } from "vitest";
import type { execFile } from "node:child_process";
import { bootstrapGithubToken } from "./githubTokenBootstrap";

const fakeExec = (result: { error?: Error; stdout?: string }, calls?: string[][]) =>
  ((
    _cmd: string,
    args: string[],
    _opts: unknown,
    cb: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    calls?.push(args);
    cb(result.error ?? null, result.stdout ?? "", "");
  }) as unknown as typeof execFile;

describe("bootstrapGithubToken", () => {
  it("exports GH_TOKEN and GITHUB_TOKEN from the gh CLI", async () => {
    const env: NodeJS.ProcessEnv = {};
    const ok = await bootstrapGithubToken({
      env,
      execFileImpl: fakeExec({ stdout: "gho_abc123\n" }),
    });
    expect(ok).toBe(true);
    expect(env.GH_TOKEN).toBe("gho_abc123");
    expect(env.GITHUB_TOKEN).toBe("gho_abc123");
  });

  it("an explicit GH_TOKEN wins — gh is never invoked", async () => {
    const calls: string[][] = [];
    const env: NodeJS.ProcessEnv = { GH_TOKEN: "explicit" };
    const ok = await bootstrapGithubToken({
      env,
      execFileImpl: fakeExec({ stdout: "gho_other" }, calls),
    });
    expect(ok).toBe(true);
    expect(env.GH_TOKEN).toBe("explicit");
    expect(calls).toHaveLength(0);
  });

  it("passes --user from T3CODE_GH_USER", async () => {
    const calls: string[][] = [];
    const env: NodeJS.ProcessEnv = { T3CODE_GH_USER: "lewiegi" };
    await bootstrapGithubToken({
      env,
      execFileImpl: fakeExec({ stdout: "gho_org" }, calls),
    });
    expect(calls[0]).toEqual(["auth", "token", "--user", "lewiegi"]);
    expect(env.GH_TOKEN).toBe("gho_org");
  });

  it("a gh failure is non-fatal and leaves env untouched", async () => {
    const env: NodeJS.ProcessEnv = {};
    const logs: string[] = [];
    const ok = await bootstrapGithubToken({
      env,
      log: (m) => logs.push(m),
      execFileImpl: fakeExec({ error: new Error("not logged in") }),
    });
    expect(ok).toBe(false);
    expect(env.GH_TOKEN).toBeUndefined();
    expect(logs).toHaveLength(1);
    expect(logs[0]).not.toContain("gho_");
  });

  it("T3CODE_GH_TOKEN_BOOTSTRAP=0 disables the lookup", async () => {
    const calls: string[][] = [];
    const env: NodeJS.ProcessEnv = { T3CODE_GH_TOKEN_BOOTSTRAP: "0" };
    const ok = await bootstrapGithubToken({
      env,
      execFileImpl: fakeExec({ stdout: "gho_abc" }, calls),
    });
    expect(ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
