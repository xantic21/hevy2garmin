import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyGarminRequest,
  createStrictFetch,
  firewallSelfTest,
  installStrictGarminFirewall,
  isStrictFirewallInstalled,
  StrictModeViolation,
  withGarminWriteCapability,
} from "../../src/strict";
import { deleteActivity, pushExerciseSets, renameActivity, updateActivityMetadata, uploadFit } from "../../src/garmin";

const API = "https://connectapi.garmin.com";
const put = (body: unknown) => ({
  method: "POST",
  headers: { "Content-Type": "application/json", "X-HTTP-Method-Override": "PUT" },
  body: JSON.stringify(body),
});

describe("classifyGarminRequest", () => {
  it("passes non-Garmin hosts, reads and authentication", () => {
    expect(classifyGarminRequest("https://api.hevyapp.com/v1/workouts", { method: "POST" }).kind).toBe("not_garmin");
    expect(classifyGarminRequest("https://evilgarmin.com/x", { method: "DELETE" }).kind).toBe("not_garmin");
    expect(classifyGarminRequest(`${API}/activity-service/activity/1/exerciseSets`).kind).toBe("read");
    expect(classifyGarminRequest("https://diauth.garmin.com/di-oauth2-service/oauth/token", { method: "POST" }).kind).toBe("auth");
    expect(classifyGarminRequest("https://sso.garmin.com/sso/signin", { method: "POST" }).kind).toBe("auth");
    expect(classifyGarminRequest(`${API}/oauth-service/oauth/exchange/user/2.0`, { method: "POST" }).kind).toBe("auth");
    expect(classifyGarminRequest(`${API}/di-oauth2-service/oauth/grant/service_ticket`, { method: "POST" }).kind).toBe("auth");
  });

  it.each([
    ["FIT upload", `${API}/upload-service/upload/.fit`, { method: "POST", body: "x" }],
    ["activity delete", `${API}/activity-service/activity/5`, { method: "DELETE" }],
    ["delete via override", `${API}/activity-service/activity/5`, { method: "POST", headers: { "x-http-method-override": "DELETE" } }],
    ["workout create", `${API}/workout-service/workout`, { method: "POST", body: "{}" }],
    ["workout schedule", `${API}/workout-service/schedule/7`, { method: "POST", body: "{}" }],
    ["gear link", `${API}/gear-service/gear/link/a/activity/5`, { method: "PUT" }],
    ["activity type change", `${API}/activity-service/activity/5`, put({ activityId: 5, activityTypeDTO: { typeKey: "running" } })],
    ["sets for another id", `${API}/activity-service/activity/5/exerciseSets`, put({ activityId: 6, exerciseSets: [] })],
    ["opaque body", `${API}/activity-service/activity/5/exerciseSets`, { method: "PUT", body: new Uint8Array([1]) as unknown as BodyInit }],
    ["GET with write override", `${API}/activity-service/activity/5`, { method: "GET", headers: { "X-HTTP-Method-Override": "PUT" } }],
  ])("forbids %s", (_name, url, init) => {
    expect(classifyGarminRequest(url, init as RequestInit).kind).toBe("forbidden");
  });

  it("recognises exactly the two strict writes", () => {
    expect(classifyGarminRequest(`${API}/activity-service/activity/5/exerciseSets`, put({ activityId: 5, exerciseSets: [] }))).toEqual({
      kind: "write",
      write: "exercise_sets",
      activityId: 5,
    });
    expect(classifyGarminRequest(`${API}/activity-service/activity/5`, put({ activityId: 5, activityName: "Push", description: "x" }))).toEqual({
      kind: "write",
      write: "metadata",
      activityId: 5,
    });
  });
});

describe("createStrictFetch", () => {
  const ok = () => vi.fn(async () => new Response(null, { status: 204 }));

  it("never reaches the network for a refused request", async () => {
    const base = ok();
    const f = createStrictFetch(base as unknown as typeof fetch);
    await expect(f(`${API}/upload-service/upload/.fit`, { method: "POST" })).rejects.toBeInstanceOf(StrictModeViolation);
    await expect(f(`${API}/activity-service/activity/5`, { method: "DELETE" })).rejects.toBeInstanceOf(StrictModeViolation);
    expect(base).not.toHaveBeenCalled();
  });

  it("admits a write only inside a scope for that activity and kind", async () => {
    const base = ok();
    const f = createStrictFetch(base as unknown as typeof fetch);
    const url = `${API}/activity-service/activity/5/exerciseSets`;
    await expect(f(url, put({ activityId: 5, exerciseSets: [] }))).rejects.toThrow(/outside a capability scope/);
    await expect(
      withGarminWriteCapability({ activityId: 6, allow: new Set(["exercise_sets"]) }, () => f(url, put({ activityId: 5, exerciseSets: [] }))),
    ).rejects.toThrow(/not 5/);
    await expect(
      withGarminWriteCapability({ activityId: 5, allow: new Set(["metadata"]) }, () => f(url, put({ activityId: 5, exerciseSets: [] }))),
    ).rejects.toThrow(/not granted/);
    expect(base).not.toHaveBeenCalled();
    await withGarminWriteCapability({ activityId: 5, allow: new Set(["exercise_sets"]) }, () => f(url, put({ activityId: 5, exerciseSets: [] })));
    expect(base).toHaveBeenCalledTimes(1);
  });

  it("isolates concurrent scopes from each other", async () => {
    const base = ok();
    const f = createStrictFetch(base as unknown as typeof fetch);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const holder = withGarminWriteCapability({ activityId: 5, allow: new Set(["exercise_sets"]) }, async () => {
      await gate;
      return f(`${API}/activity-service/activity/5/exerciseSets`, put({ activityId: 5, exerciseSets: [] }));
    });
    // A request that starts while the other scope is open is NOT inside it.
    const outsider = f(`${API}/activity-service/activity/5/exerciseSets`, put({ activityId: 5, exerciseSets: [] }));
    await expect(outsider).rejects.toBeInstanceOf(StrictModeViolation);
    release();
    await holder;
    expect(base).toHaveBeenCalledTimes(1);
  });
});

describe("installStrictGarminFirewall over the real Garmin functions", () => {
  let uninstall: () => void = () => {};
  afterEach(() => uninstall());

  const fakeClient = () =>
    ({
      domain: "garmin.com",
      di_token: "t",
      refreshDiToken: async () => {},
      connectapi: async () => [],
    }) as never;

  it("refuses upload, delete and out-of-scope edits made by the engine's own functions", async () => {
    const network = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }));
    const target = { fetch: network as unknown as typeof fetch };
    uninstall = installStrictGarminFirewall(target);
    const original = globalThis.fetch;
    globalThis.fetch = target.fetch;
    try {
      expect(isStrictFirewallInstalled(target)).toBe(true);
      await expect(uploadFit(fakeClient(), new Uint8Array([1, 2]), undefined)).rejects.toBeInstanceOf(StrictModeViolation);
      await expect(deleteActivity(fakeClient(), 5)).rejects.toBeInstanceOf(StrictModeViolation);
      await expect(renameActivity(fakeClient(), 5, "x")).rejects.toBeInstanceOf(StrictModeViolation);
      await expect(pushExerciseSets(fakeClient(), 5, { activityId: 5, exerciseSets: [] })).rejects.toBeInstanceOf(StrictModeViolation);
      expect(network).not.toHaveBeenCalled();
      await withGarminWriteCapability({ activityId: 5, allow: new Set(["exercise_sets", "metadata"]) }, async () => {
        await pushExerciseSets(fakeClient(), 5, { activityId: 5, exerciseSets: [] });
        await updateActivityMetadata(fakeClient(), 5, { activityName: "Push" });
      });
      expect(network).toHaveBeenCalledTimes(2);
      // Installing twice is a no-op, not a double wrap.
      installStrictGarminFirewall(target)();
      expect(isStrictFirewallInstalled(target)).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("one process, several copies of the engine (bundlers)", () => {
  it("a capability opened by one copy is honoured by a firewall another copy installed", async () => {
    const { vi: v } = await import("vitest");
    v.resetModules();
    const copyA = await import("../../src/strict/firewall");
    v.resetModules();
    const copyB = await import("../../src/strict/firewall");
    expect(copyA).not.toBe(copyB);
    const network = v.fn(async () => new Response(null, { status: 204 }));
    const target = { fetch: network as unknown as typeof fetch };
    copyA.installStrictGarminFirewall(target);
    const url = "https://connectapi.garmin.com/activity-service/activity/5/exerciseSets";
    const init = { method: "POST", headers: { "X-HTTP-Method-Override": "PUT" }, body: JSON.stringify({ activityId: 5, exerciseSets: [] }) };
    await copyB.withGarminWriteCapability({ activityId: 5, allow: new Set(["exercise_sets"]) }, () => target.fetch(url, init));
    expect(network).toHaveBeenCalledTimes(1);
    // A refusal thrown by copy A is recognised by copy B.
    const err = await target.fetch("https://connectapi.garmin.com/upload-service/upload/.fit", { method: "POST" }).catch((e) => e);
    expect(copyB.isStrictModeViolation(err)).toBe(true);
    // Counters are shared too.
    expect(copyA.firewallStats().blocked).toBe(copyB.firewallStats().blocked);
  });

  it("the self-test proves enforcement without touching the network", async () => {
    const { vi: v } = await import("vitest");
    const network = v.fn(async () => {
      throw new TypeError("getaddrinfo ENOTFOUND h2g-firewall-selftest.invalid");
    });
    const bare = { fetch: network as unknown as typeof fetch };
    expect(await firewallSelfTest(bare)).toBe(false);
    installStrictGarminFirewall(bare);
    const before = network.mock.calls.length;
    expect(await firewallSelfTest(bare)).toBe(true);
    expect(network.mock.calls.length).toBe(before);
  });

  it("re-wraps when something else became the outer fetch, so the policy is always first", async () => {
    const { vi: v } = await import("vitest");
    const network = v.fn(async () => new Response(null, { status: 200 }));
    const target = { fetch: network as unknown as typeof fetch };
    installStrictGarminFirewall(target);
    const inner = target.fetch;
    target.fetch = ((i: RequestInfo | URL, init?: RequestInit) => inner(i, init)) as typeof fetch; // e.g. Next's cache patch
    expect(isStrictFirewallInstalled(target)).toBe(false);
    installStrictGarminFirewall(target);
    expect(isStrictFirewallInstalled(target)).toBe(true);
    expect(await firewallSelfTest(target)).toBe(true);
  });
});

describe("closed re-audit finding #2", () => {
  it("an uninspectable target is refused, not waved through", () => {
    const weird = { toString: () => "::not a url::" };
    expect(classifyGarminRequest(weird, { method: "POST" }).kind).toBe("forbidden");
  });

  it("a URL-like object is classified by its string form", () => {
    const like = { toString: () => "https://connectapi.garmin.com/upload-service/upload/.fit" };
    expect(classifyGarminRequest(like, { method: "POST" }).kind).toBe("forbidden");
  });

  it("a trailing-dot host is still Garmin", () => {
    expect(classifyGarminRequest("https://connectapi.garmin.com./upload-service/upload/.fit", { method: "POST" }).kind).toBe("forbidden");
    expect(classifyGarminRequest("https://CONNECTAPI.GARMIN.COM../activity-service/activity/5", { method: "DELETE" }).kind).toBe("forbidden");
  });

  it("the override header never turns another real method into an allowed write", () => {
    const body = JSON.stringify({ activityId: 123, activityName: "x" });
    for (const method of ["DELETE", "PATCH", "OPTIONS"]) {
      expect(
        classifyGarminRequest(`${API}/activity-service/activity/123`, { method, headers: { "X-HTTP-Method-Override": "PUT" }, body }).kind,
        method,
      ).toBe("forbidden");
    }
    expect(classifyGarminRequest(`${API}/activity-service/activity/123`, { method: "PUT", headers: { "x-http-method-override": " put " }, body }).kind).toBe("write");
    expect(classifyGarminRequest(`${API}/activity-service/activity/123`, { method: "PUT", headers: { "X-HTTP-Method-Override": "DELETE" }, body }).kind).toBe("forbidden");
  });
});
