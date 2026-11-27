/**
 * The deployment quarantine (gates E–G): Vercel may build exactly one thing,
 * a PREVIEW in synthetic staging mode. Production stays refused twice, by the
 * ignored build step and by next.config.ts; automatic Git deployments and
 * Vercel crons stay off.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const ignore = (env: Record<string, string>) => {
  try {
    execFileSync(process.execPath, [join(__dirname, "scripts", "vercel-ignore.mjs")], { env: { PATH: process.env.PATH ?? "", ...env } as unknown as NodeJS.ProcessEnv, stdio: "pipe" });
    return 0;
  } catch (e) {
    return (e as { status: number }).status;
  }
};

describe("Vercel ignored build step (exit 1 = build)", () => {
  it.each([
    [{ VERCEL_ENV: "preview", H2G_STAGING: "synthetic" }, 1],
    [{ VERCEL_ENV: "production", H2G_STAGING: "synthetic" }, 0],
    [{ VERCEL_ENV: "preview" }, 0],
    [{ VERCEL_ENV: "preview", H2G_STAGING: "Synthetic" }, 0],
    [{ VERCEL_ENV: "development", H2G_STAGING: "synthetic" }, 0],
    [{}, 0],
  ])("%o → %i", (env, code) => {
    expect(ignore(env as Record<string, string>)).toBe(code);
  });
});

describe("next.config.ts refuses every Vercel build but a synthetic-staging preview", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });
  const load = async (env: Record<string, string>) => {
    for (const [k, v] of Object.entries({ VERCEL_ENV: "", H2G_STAGING: "", ...env })) vi.stubEnv(k, v);
    vi.resetModules();
    return import("./next.config");
  };
  it("production, even with the staging flag: refused", async () => {
    await expect(load({ VERCEL_ENV: "production", H2G_STAGING: "synthetic" })).rejects.toThrow(/not approved/);
  });
  it("a preview without the staging flag: refused", async () => {
    await expect(load({ VERCEL_ENV: "preview" })).rejects.toThrow(/not approved/);
  });
  it("a synthetic-staging preview: allowed", async () => {
    await expect(load({ VERCEL_ENV: "preview", H2G_STAGING: "synthetic" })).resolves.toBeTruthy();
  });
  it("off Vercel (Docker, local): unchanged", async () => {
    await expect(load({})).resolves.toBeTruthy();
  });
});

describe("vercel.json files", () => {
  const web = JSON.parse(readFileSync(join(__dirname, "vercel.json"), "utf8"));
  const root = JSON.parse(readFileSync(join(__dirname, "..", "vercel.json"), "utf8"));
  it("no automatic Git deployments and no Vercel crons, in both roots", () => {
    for (const c of [web, root]) {
      expect(c.git.deploymentEnabled).toBe(false);
      expect(c.crons).toEqual([]);
    }
  });
  it("the web project builds only through the staging gate; the repository root never builds", () => {
    expect(web.ignoreCommand).toBe("node scripts/vercel-ignore.mjs");
    expect(root.ignoreCommand).toBe("exit 0");
    expect(web.installCommand).toMatch(/^cd \.\.\/typescript && npm ci .*npm run build && cd \.\.\/web && npm ci/);
  });
});
