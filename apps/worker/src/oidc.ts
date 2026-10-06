// Trust one workflow on this repository's main branch. No permanent CI secret needed.
const issuer = "https://token.actions.githubusercontent.com";
const audience = "crime-radar-ingestion";
const reject = (reason: string) => {
  console.warn(JSON.stringify({ event: "harvest-auth-rejected", reason }));
  return false;
};
export const harvestWorkflow =
  "litinskii/crime/.github/workflows/harvest-courts.yml@refs/heads/main";
let cache:
  { keys: (JsonWebKey & { kid?: string })[]; until: number } | undefined;
function decode(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw Error("Invalid token encoding");
  return Uint8Array.from(
    atob(
      value
        .replaceAll("-", "+")
        .replaceAll("_", "/")
        .padEnd(Math.ceil(value.length / 4) * 4, "="),
    ),
    (c) => c.charCodeAt(0),
  );
}
export async function authorizedHarvester(request: Request): Promise<boolean> {
  let phase = "decode";
  try {
    const token = request.headers
      .get("Authorization")
      ?.match(/^Bearer ([A-Za-z0-9_.-]{1,12000})$/)?.[1];
    if (!token) return false;
    const parts = token.split(".");
    if (parts.length !== 3) return false;
    const header = JSON.parse(new TextDecoder().decode(decode(parts[0]))),
      claims = JSON.parse(new TextDecoder().decode(decode(parts[1])));
    const now = Math.floor(Date.now() / 1000);
    if (
      header.alg !== "RS256" ||
      typeof header.kid !== "string" ||
      claims.iss !== issuer ||
      claims.aud !== audience ||
      claims.repository !== "litinskii/crime" ||
      claims.repository_id !== "1406961985" ||
      claims.repository_owner_id !== "10028441" ||
      claims.ref !== "refs/heads/main" ||
      claims.workflow_ref !== harvestWorkflow ||
      claims.sub !==
        "repo:litinskii@10028441/crime@1406961985:ref:refs/heads/main" ||
      typeof claims.exp !== "number" ||
      claims.exp <= now ||
      typeof claims.nbf !== "number" ||
      claims.nbf > now + 30 ||
      typeof claims.iat !== "number" ||
      claims.iat > now + 30 ||
      claims.iat < now - 600
    )
      return reject("claims");
    if (
      !cache ||
      cache.until < Date.now() ||
      !cache.keys.some((key) => key.kid === header.kid)
    ) {
      phase = "fetch-keys";
      const response = await fetch(`${issuer}/.well-known/jwks`, {
        signal: AbortSignal.timeout(10000),
        redirect: "error",
      });
      if (!response.ok) return reject(`keys-http-${response.status}`);
      const data = (await response.json()) as {
        keys: (JsonWebKey & { kid?: string })[];
      };
      if (!Array.isArray(data.keys) || data.keys.length > 20) return false;
      cache = { keys: data.keys, until: Date.now() + 3600000 };
    }
    const jwk = cache.keys.find(
      (key) =>
        key.kid === header.kid &&
        key.kty === "RSA" &&
        key.alg === "RS256" &&
        key.use === "sig",
    );
    if (!jwk) return reject("key-not-found");
    phase = "import-key";
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    phase = "verify-signature";
    return await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      decode(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
  } catch (error) {
    return reject(
      `${phase}:${error instanceof Error ? error.name : "verification-error"}`,
    );
  }
}
