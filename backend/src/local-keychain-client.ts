import { env } from "./env.js";
import {
  type LocalCredentialService,
  localKeychainAccount,
} from "./local-credential-types.js";

interface KeychainGetResponse {
  apiKey: string | null;
  keychainAccount: string;
}

interface KeychainSetResponse {
  keychainAccount: string;
}

type KeychainResponseValidator<T> = (payload: unknown) => payload is T;

function isJsonObject(payload: unknown): payload is Record<string, unknown> {
  return (
    payload !== null && typeof payload === "object" && !Array.isArray(payload)
  );
}

function isKeychainGetResponse(
  payload: unknown,
): payload is KeychainGetResponse {
  return (
    isJsonObject(payload) &&
    (typeof payload.apiKey === "string" || payload.apiKey === null) &&
    typeof payload.keychainAccount === "string"
  );
}

function isKeychainSetResponse(
  payload: unknown,
): payload is KeychainSetResponse {
  return isJsonObject(payload) && typeof payload.keychainAccount === "string";
}

function requireKeychainConfig(): { url: string; token: string } {
  if (!env.LOCAL_KEYCHAIN_URL || !env.LOCAL_KEYCHAIN_TOKEN) {
    throw new Error(
      "Local keychain bridge is not configured. Run `make dev` to start it.",
    );
  }
  return { url: env.LOCAL_KEYCHAIN_URL, token: env.LOCAL_KEYCHAIN_TOKEN };
}

function keychainUrl(path: string): string {
  const { url } = requireKeychainConfig();
  return new URL(path, url).toString();
}

async function keychainRequest<T>(
  path: string,
  body: Record<string, unknown>,
  validatePayload: KeychainResponseValidator<T>,
): Promise<T> {
  const { token } = requireKeychainConfig();
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    env.LOCAL_KEYCHAIN_TIMEOUT_MS,
  );

  try {
    const response = await fetch(keychainUrl(path), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const payload: unknown = await response.json().catch(() => null);

    if (!response.ok) {
      const bridgeError =
        isJsonObject(payload) && typeof payload.error === "string"
          ? payload.error
          : null;
      throw new Error(
        bridgeError || `Keychain bridge error (${response.status})`,
      );
    }

    if (!isJsonObject(payload)) {
      throw new Error(
        `Keychain bridge returned an invalid response for ${path}: expected a JSON object.`,
      );
    }

    if (!validatePayload(payload)) {
      throw new Error(
        `Keychain bridge returned an invalid response for ${path}.`,
      );
    }

    return payload;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("Local keychain bridge timed out.");
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

export function expectedKeychainAccount(
  service: LocalCredentialService,
): string {
  return localKeychainAccount(env.BIGSET_LOCAL_WORKSPACE_ID, service);
}

export async function getKeychainCredential(
  service: LocalCredentialService,
): Promise<{ apiKey: string; keychainAccount: string } | null> {
  const result = await keychainRequest<KeychainGetResponse>(
    "/credentials/get",
    {
      service,
    },
    isKeychainGetResponse,
  );

  if (!result.apiKey) return null;
  return {
    apiKey: result.apiKey,
    keychainAccount: result.keychainAccount,
  };
}

export async function setKeychainCredential(
  service: LocalCredentialService,
  apiKey: string,
): Promise<{ keychainAccount: string }> {
  return await keychainRequest<KeychainSetResponse>(
    "/credentials/set",
    {
      service,
      apiKey,
    },
    isKeychainSetResponse,
  );
}
