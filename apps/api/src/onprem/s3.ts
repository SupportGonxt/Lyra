import { sha256Hex } from "@lyra/core";

// docs/11 §3 — the on-prem object-store adapter: MinIO (or any S3 API) standing
// in for R2. node.ts wires `FILES` here when `S3_ENDPOINT` is set, and to the
// local filesystem otherwise — the rest of the app cannot tell the difference,
// because both answer the same `{ put(key, bytes), get(key) }` surface.
//
// SigV4 is implemented here (not pulled from a dependency) so the Workers-first
// bundle never grows a client it will not use: this module is only imported from
// node.ts, the RUNTIME=node entrypoint. Keys are server-built and URL-safe
// (`exports/<tenant>/<id>.<fmt>`), so path encoding is `encodeURIComponent` per
// segment rather than S3's full double-encoding for hostile keys.

const enc = new TextEncoder();

function toHex(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** HMAC-SHA256 with a raw-bytes key — SigV4 chains the previous digest as the next key. */
async function hmacBytes(key: Uint8Array, message: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", key as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(message)));
}

export interface S3StoreOptions {
  endpoint: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  /** Defaults to us-east-1, the region MinIO answers with out of the box. */
  region?: string;
  fetch?: typeof fetch;
}

export interface ObjectStore {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<{ body: ReadableStream | null } | null>;
}

/** `bucket/key` as an S3 path — each segment percent-encoded, separators kept. */
export function s3Path(bucket: string, key: string): string {
  const segments = key.split("/").map(encodeURIComponent);
  return `/${encodeURIComponent(bucket)}/${segments.join("/")}`;
}

/**
 * The SigV4 Authorization header for one S3 request. Exported so the test can
 * pin the canonical request and the credential scope — the two places a
 * hand-rolled signer is most likely to drift.
 */
export async function s3Authorization(
  method: string,
  path: string,
  headers: Record<string, string>,
  payloadHash: string,
  opts: Required<Pick<S3StoreOptions, "accessKey" | "secretKey" | "region">>,
  isoDate: string
): Promise<{ authorization: string; signedHeaders: string; canonicalRequest: string }> {
  const date = isoDate.slice(0, 8);
  const scope = `${date}/${opts.region}/s3/aws4_request`;
  const host = headers["host"]!;
  // Canonical headers: lowercase keys, sorted, trimmed, no duplicates.
  const canonicalHeaders =
    `host:${host}\n` + `x-amz-content-sha256:${payloadHash}\n` + `x-amz-date:${isoDate}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = `${method}\n${path}\n\n${canonicalHeaders}${signedHeaders}\n${payloadHash}`;
  const stringToSign = `AWS4-HMAC-SHA256\n${isoDate}\n${scope}\n${await sha256Hex(canonicalRequest)}`;

  const kDate = await hmacBytes(enc.encode(`AWS4${opts.secretKey}`), date);
  const kRegion = await hmacBytes(kDate, opts.region);
  const kService = await hmacBytes(kRegion, "s3");
  const kSigning = await hmacBytes(kService, "aws4_request");
  const signature = toHex(await hmacBytes(kSigning, stringToSign));

  return {
    authorization: `AWS4-HMAC-SHA256 Credential=${opts.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    signedHeaders,
    canonicalRequest
  };
}

export function s3ObjectStore(options: S3StoreOptions): ObjectStore {
  const endpoint = options.endpoint.replace(/\/$/, "");
  const bucket = options.bucket;
  const region = options.region ?? "us-east-1";
  const doFetch = options.fetch ?? fetch;
  const iso = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");

  async function request(method: "PUT" | "GET", key: string, bytes?: Uint8Array): Promise<Response> {
    const path = s3Path(bucket, key);
    const payloadHash = await sha256Hex(bytes ?? new Uint8Array(0));
    const url = new URL(`${endpoint}${path}`);
    const isoDate = iso();
    const headers: Record<string, string> = {
      host: url.host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": isoDate
    };
    const { authorization } = await s3Authorization(
      method,
      path,
      headers,
      payloadHash,
      { accessKey: options.accessKey, secretKey: options.secretKey, region },
      isoDate
    );
    const outbound = { ...headers, authorization };
    return bytes !== undefined
      ? doFetch(url, { method, headers: outbound, body: bytes })
      : doFetch(url, { method, headers: outbound });
  }

  return {
    async put(key, bytes) {
      const res = await request("PUT", key, bytes);
      if (!res.ok) throw new Error(`s3 put ${res.status}: ${(await res.text()).slice(0, 200)}`);
    },
    async get(key) {
      const res = await request("GET", key);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`s3 get ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return { body: res.body };
    }
  };
}
