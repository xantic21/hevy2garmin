import { afterEach, describe, expect, it, vi } from "vitest";
import { runStrictSync, strictEnvStop } from "./strict-sync";

describe("H2G_STRICT_STOP, the deployment-level stop switch", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("parses only clear true values", () => {
    expect(strictEnvStop({})).toBe(false);
    expect(strictEnvStop({ H2G_STRICT_STOP: "0" })).toBe(false);
    expect(strictEnvStop({ H2G_STRICT_STOP: "1" })).toBe(true);
    expect(strictEnvStop({ H2G_STRICT_STOP: " TRUE " })).toBe(true);
  });

  it("blocks a live run before touching the database, Hevy or Garmin", async () => {
    vi.stubEnv("H2G_STRICT_STOP", "1");
    const sql = vi.fn() as never;
    const fetchWorkouts = vi.fn();
    const garminClientFactory = vi.fn();
    const r = await runStrictSync(sql, { dryRun: false, trigger: "manual", fetchWorkouts, garminClientFactory });
    expect(r).toMatchObject({ status: "blocked", writes: 0 });
    expect(sql).not.toHaveBeenCalled();
    expect(fetchWorkouts).not.toHaveBeenCalled();
    expect(garminClientFactory).not.toHaveBeenCalled();
  });
});
