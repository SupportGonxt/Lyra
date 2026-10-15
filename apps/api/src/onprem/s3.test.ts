import { afterEach, describe, expect, it, vi } from "vitest";
import { s3Authorization, s3ObjectStore, s3Path } from "./s3.js";

// ADR on-prem storage: the MinIO/S3 adapter that replaces the local-filesystem
// R2 stand-in when S3_ENDPOINT is set. The signer is pinned on its canonical
// request and credential scope — the two places a hand-rolled SigV4 drifts.

const CREDS = { accessKey: "AKIAIOSFODNN7EXAMPLE", secretKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", region: "us-east-1" };

describe("s3Path", () => {
  it("percent-encodes each segment and keeps the separators", () => {
    expect(s3Path("lyra-files", "exports/t_1/board.pdf")).toBe("/lyra-files/exports/t_1/board.pdf");
  });

  it("encodes a segment that is not URL-safe", () => {
    expect(s3Path("lyra-files", "a b/c%d")).toBe("/lyra-files/a%20b/c%25d");
  });
});

describe("s3Authorization", () => {
  it("builds the canonical request, credential scope and a hex signature", async () => {
    const headers = { host: "minio:9000", "x-amz-content-sha256": "h", "x-amz-date": "20261014T120000Z" };
    const auth = await s3Authorization("PUT", "/lyra-files/a/b.pdf", headers, "payload-hash", CREDS, "20261014T120000Z");

    expect(auth.signedHeaders).toBe("host;x-amz-content-sha256;x-amz-date");
    expect(auth.canonicalRequest).toBe(
      "PUT\n/lyra-files/a/b.pdf\n\nhost:minio:9000\nx-amz-content-sha256:payload-hash\nx-amz-date:20261014T120000Z\nhost;x-amz-content-sha256;x-amz-date\npayload-hash"
    );
    expect(auth.authorization).toContain("AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20261014/us-east-1/s3/aws4_request");
    expect(auth.authorization).toContain("SignedHeaders=host;x-amz-content-sha256;x-amz-date");
    expect(auth.authorization).toMatch(/Signature=[0-9a-f]{64}$/);
  });

  it("is deterministic for the same timestamp", async () => {
    const headers = { host: "minio:9000", "x-amz-content-sha256": "h", "x-amz-date": "20261014T120000Z" };
    const a = await s3Authorization("GET", "/lyra-files/a", headers, "h", CREDS, "20261014T120000Z");
    const b = await s3Authorization("GET", "/lyra-files/a", headers, "h", CREDS, "20261014T120000Z");
    expect(a.authorization).toBe(b.authorization);
  });
});

describe("s3ObjectStore", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("PUTs an object with a signed authorization header", async () => {
    const calls: { url: string; method: string; headers: Record<string, string>; body: string }[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: String(init?.method ?? "GET"),
        headers: (init?.headers as Record<string, string>) ?? {},
        body: String(init?.body ?? "")
      });
      return new Response("", { status: 200 });
    });

    const store = s3ObjectStore({ endpoint: "http://minio:9000", bucket: "lyra-files", ...CREDS });
    await store.put("exports/t_1/x.xlsx", new TextEncoder().encode("hello"));

    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.url).toBe("http://minio:9000/lyra-files/exports/t_1/x.xlsx");
    expect(calls[0]!.headers["authorization"]).toContain("AWS4-HMAC-SHA256");
    expect(calls[0]!.headers["x-amz-content-sha256"]).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"); // sha256("hello")
  });

  it("GETs an object and returns its body; 404 is null", async () => {
    vi.stubGlobal(
      "fetch",
      async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("/missing")) return new Response("", { status: 404 });
        return new Response("hello", { status: 200 });
      }
    );

    const store = s3ObjectStore({ endpoint: "http://minio:9000", bucket: "lyra-files", ...CREDS });
    const hit = await store.get("exports/t_1/x.xlsx");
    expect(hit).not.toBeNull();
    expect(await new Response(hit!.body).text()).toBe("hello");

    await expect(store.get("missing")).resolves.toBeNull();
  });
});
