/**
 * Cross-site request forgery on the strict operator routes (re-audit #3, F9):
 * a mutating request from another origin, including another port on
 * localhost, and a non-JSON body (a "simple" cross-origin POST) are refused.
 */
import { describe, expect, it } from "vitest";
import { sameOriginJsonRefusal } from "./strict-ops-route";

const post = (headers: Record<string, string>, body: string | null = "{}") =>
  new Request("http://localhost:8096/api/strict/gate-f", { method: "POST", headers, body });

describe("strict operator routes: same origin, JSON only", () => {
  it("accepts the dashboard's own request", () => {
    expect(sameOriginJsonRefusal(post({ host: "localhost:8096", origin: "http://localhost:8096", "content-type": "application/json" }))).toBeNull();
    expect(sameOriginJsonRefusal(post({ host: "localhost:8096", "content-type": "application/json; charset=utf-8" }))).toBeNull();
    expect(sameOriginJsonRefusal(post({ host: "internal:3000", "x-forwarded-host": "h2g.example.com", origin: "https://h2g.example.com", "content-type": "application/json" }))).toBeNull();
  });

  it.each([
    "http://localhost:3000",
    "http://127.0.0.1:8096",
    "https://evil.example",
    "null",
    "not a url",
  ])("refuses a request from another origin (%s)", async (origin) => {
    const r = sameOriginJsonRefusal(post({ host: "localhost:8096", origin, "content-type": "application/json" }));
    expect(r?.status).toBe(403);
  });

  it.each(["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", ""])("refuses a body that is not JSON (%s)", (type) => {
    const headers: Record<string, string> = { host: "localhost:8096", origin: "http://localhost:8096" };
    if (type) headers["content-type"] = type;
    expect(sameOriginJsonRefusal(post(headers, '{"action":"run"}'))?.status).toBe(415);
  });

  it("a request without a body needs no content type", () => {
    expect(sameOriginJsonRefusal(new Request("http://localhost:8096/api/strict/freeze", { method: "POST", headers: { host: "localhost:8096" } }))).toBeNull();
  });
});
