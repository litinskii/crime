import { it, expect, vi, afterEach } from "vitest";
import { authorizedHarvester, harvestWorkflow } from "./oidc";
afterEach(() => vi.unstubAllGlobals());
it("accepts signed tokens only for the exact harvest workflow, repository identity and main branch", async () => {
  const keys = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
  const kid = crypto.randomUUID();
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({ keys: [{ ...jwk, kid, alg: "RS256", use: "sig" }] }),
        ),
    ),
  );
  const now = Math.floor(Date.now() / 1000),
    claims = {
      iss: "https://token.actions.githubusercontent.com",
      aud: "crime-radar-ingestion",
      repository: "litinskii/crime",
      repository_id: "1406961985",
      repository_owner_id: "10028441",
      ref: "refs/heads/main",
      workflow_ref: harvestWorkflow,
      sub: "repo:litinskii/crime:ref:refs/heads/main",
      iat: now,
      nbf: now,
      exp: now + 300,
    };
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  async function token(c: object) {
    const prefix = `${encode({ alg: "RS256", kid })}.${encode(c)}`;
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      keys.privateKey,
      new TextEncoder().encode(prefix),
    );
    return `${prefix}.${Buffer.from(signature).toString("base64url")}`;
  }
  const auth = (value: string) =>
    authorizedHarvester(
      new Request("https://example.test/internal/court", {
        headers: { Authorization: `Bearer ${value}` },
      }),
    );
  const signed = await token(claims);
  expect(await auth(signed)).toBe(true);
  for (const wrong of [
    { ref: "refs/heads/other" },
    { repository_id: "1" },
    {
      workflow_ref:
        "litinskii/crime/.github/workflows/verify.yml@refs/heads/main",
    },
    { exp: now - 1 },
    { aud: "other" },
  ])
    expect(await auth(await token({ ...claims, ...wrong }))).toBe(false);
  expect(await auth(signed.slice(0, -10) + "1234567890")).toBe(false);
});
