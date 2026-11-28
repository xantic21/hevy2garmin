/**
 * Credential entry points in a strict deployment (review round 2, finding 4).
 *
 * Without H2G_CREDENTIALS_KEY nothing may be stored in plaintext, so every route
 * that would receive a credential refuses BEFORE it sends anything anywhere: no
 * Garmin sign-in via the Worker, no Hevy key probe, no token write. With a key,
 * the routes store a sealed envelope. The rotation route needs a session and an
 * explicit confirmation. Synthetic values only; the network is mocked.
 */
import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  workerLogin: vi.fn(),
  workerLoginMfa: vi.fn(),
  exchangeTicket: vi.fn(),
  fetchWorkoutCount: vi.fn(),
  writes: [] as Array<{ q: string; values: unknown[] }>,
  authorized: true,
}));

vi.mock("@/lib/garmin-login-worker", async (orig) => ({ ...(await orig<object>()), workerLogin: h.workerLogin, workerLoginMfa: h.workerLoginMfa, exchangeTicket: h.exchangeTicket }));
vi.mock("@/lib/hevy-sync", async (orig) => ({ ...(await orig<object>()), fetchWorkoutCount: h.fetchWorkoutCount }));
vi.mock("@/lib/garmin-cooldown", () => ({ cooldownRemaining: async () => 0, formatCooldown: () => "", clearCooldown: async () => {} }));
vi.mock("@/lib/strict-routes", async (orig) => ({ ...(await orig<object>()), strictAuthorized: async () => h.authorized }));
vi.mock("@/lib/db", () => {
  const tag = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const q = strings.join("?");
    if (/INSERT|UPDATE|DELETE/.test(q)) h.writes.push({ q, values });
    return [];
  }) as unknown as { (): unknown; json: <T>(v: T) => T };
  tag.json = (v) => v;
  return { getDb: () => tag };
});

const post = (url: string, body: unknown) =>
  new Request(url, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  h.writes = [];
  h.authorized = true;
  vi.stubEnv("DATABASE_URL", "postgres://synthetic@localhost/none");
  vi.stubEnv("H2G_CREDENTIALS_KEY", "");
  h.fetchWorkoutCount.mockResolvedValue(3);
  h.workerLogin.mockResolvedValue({ status: "success", di_token: "syn-a", di_refresh_token: "syn-b", di_client_id: "syn-c" });
  h.workerLoginMfa.mockResolvedValue({ status: "success", di_token: "syn-a", di_refresh_token: "syn-b", di_client_id: "syn-c" });
});

describe("strict without H2G_CREDENTIALS_KEY: refuse before anything leaves the server", () => {
  it("Garmin sign-in does not call the login Worker", async () => {
    const { POST } = await import("./garmin-login/route");
    const res = await POST(post("http://x/api/garmin-login", { email: "synthetic@example.invalid", password: "synthetic" }));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/H2G_CREDENTIALS_KEY/);
    expect(h.workerLogin).not.toHaveBeenCalled();
    expect(h.writes).toEqual([]);
  });

  it("the MFA step does not call the login Worker", async () => {
    const { POST } = await import("./garmin-login-mfa/route");
    const res = await POST(post("http://x/api/garmin-login-mfa", { session_id: "s", mfa_code: "123456" }));
    expect(res.status).toBe(503);
    expect(h.workerLoginMfa).not.toHaveBeenCalled();
  });

  it("a Garmin ticket is not spent with Garmin when its tokens could not be stored (re-audit #2)", async () => {
    const { POST } = await import("./garmin-ticket-exchange/route");
    const res = await POST(post("http://x/api/garmin-ticket-exchange", { ticket: "ST-synthetic-0001" }));
    expect(res.status).toBe(503);
    expect(h.exchangeTicket).not.toHaveBeenCalled();
  });

  it("a pasted Garmin ticket's tokens are not stored", async () => {
    const { POST } = await import("./garmin-ticket/route");
    const res = await POST(post("http://x/api/garmin-ticket", { tokens: { di_token: "a", di_refresh_token: "b", di_client_id: "c" } }));
    expect(res.status).toBe(503);
    expect(h.writes).toEqual([]);
  });

  it("a Hevy key is neither probed against Hevy nor stored", async () => {
    const { POST } = await import("./connect-hevy/route");
    const res = await POST(post("http://x/api/connect-hevy", { key: "synthetic-hevy-key" }));
    expect(res.status).toBe(503);
    expect(h.fetchWorkoutCount).not.toHaveBeenCalled();
    expect(h.writes).toEqual([]);
  });
});

describe("strict with a key: what is written is sealed", () => {
  beforeEach(() => {
    vi.stubEnv("H2G_CREDENTIALS_KEY", randomBytes(32).toString("base64"));
  });

  const assertSealedWrite = (secret: string) => {
    expect(h.writes).toHaveLength(1);
    const stored = JSON.stringify(h.writes[0].values);
    expect(stored).toContain("h2g-aesgcm-v1");
    expect(stored).not.toContain(secret);
  };

  it("Hevy key", async () => {
    const { POST } = await import("./connect-hevy/route");
    const res = await POST(post("http://x/api/connect-hevy", { key: "synthetic-hevy-key" }));
    expect(res.status).toBe(200);
    assertSealedWrite("synthetic-hevy-key");
  });

  it("Garmin tokens from a sign-in", async () => {
    const { POST } = await import("./garmin-login/route");
    const res = await POST(post("http://x/api/garmin-login", { email: "synthetic@example.invalid", password: "synthetic" }));
    expect((await res.json()).status).toBe("connected");
    assertSealedWrite("syn-a");
  });

  it("Garmin tokens from a ticket", async () => {
    const { POST } = await import("./garmin-ticket/route");
    const res = await POST(post("http://x/api/garmin-ticket", { tokens: { di_token: "syn-ticket-token", di_refresh_token: "b", di_client_id: "c" } }));
    expect(res.status).toBe(200);
    assertSealedWrite("syn-ticket-token");
  });
});

describe("POST /api/strict/credentials (migration and rotation)", () => {
  it("needs a signed-in session", async () => {
    h.authorized = false;
    const { POST } = await import("./strict/credentials/route");
    const res = await POST(post("http://x/api/strict/credentials", { confirm: "ENCRYPT" }));
    expect(res.status).toBe(401);
    expect(h.writes).toEqual([]);
  });

  it("does nothing without the confirmation", async () => {
    vi.stubEnv("H2G_CREDENTIALS_KEY", randomBytes(32).toString("base64"));
    const { POST } = await import("./strict/credentials/route");
    const res = await POST(post("http://x/api/strict/credentials", {}));
    expect(await res.json()).toMatchObject({ ok: true, changed: false, reason: "confirm must be ENCRYPT" });
    expect(h.writes).toEqual([]);
  });

  it("reports the missing key instead of pretending to encrypt", async () => {
    const { POST } = await import("./strict/credentials/route");
    const res = await POST(post("http://x/api/strict/credentials", { confirm: "ENCRYPT" }));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/H2G_CREDENTIALS_KEY is not set/);
  });

  it("GET reports counts and never a value", async () => {
    const { GET } = await import("./strict/credentials/route");
    const res = await GET(new Request("http://x/api/strict/credentials"));
    const body = await res.json();
    expect(body.credentials).toMatchObject({ configured: false, rows: 0, plaintext: 0 });
  });
});
