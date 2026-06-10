export const OPENROUTER_VERIFIER_KEY = "bigset:openrouter-code-verifier";
export const OPENROUTER_RETURN_TO_KEY = "bigset:openrouter-return-to";

function base64Url(bytes: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function sha256(value: string): Promise<ArrayBuffer> {
  return await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
}

function randomVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64Url(bytes.buffer);
}

function safeReturnTo(returnTo: string): string {
  if (!returnTo.startsWith("/") || returnTo.startsWith("//")) return "/setup";
  return returnTo;
}

export async function beginOpenRouterOAuth(returnTo = "/setup") {
  const verifier = randomVerifier();
  const challenge = base64Url(await sha256(verifier));
  sessionStorage.setItem(OPENROUTER_VERIFIER_KEY, verifier);
  sessionStorage.setItem(OPENROUTER_RETURN_TO_KEY, safeReturnTo(returnTo));

  const callbackUrl = `${window.location.origin}/setup/openrouter/callback`;
  const url = new URL("https://openrouter.ai/auth");
  url.searchParams.set("callback_url", callbackUrl);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  window.location.href = url.toString();
}

export function getOpenRouterOAuthReturnTo(): string {
  const returnTo = sessionStorage.getItem(OPENROUTER_RETURN_TO_KEY);
  return returnTo ? safeReturnTo(returnTo) : "/setup";
}

export function clearOpenRouterOAuthState() {
  sessionStorage.removeItem(OPENROUTER_VERIFIER_KEY);
  sessionStorage.removeItem(OPENROUTER_RETURN_TO_KEY);
}
