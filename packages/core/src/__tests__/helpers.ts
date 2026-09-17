import { CryptoEngine, type Identity } from "../crypto/engine";
import { generateSigningKey } from "../crypto/signing";
import { uuidV7 } from "../util/ids";

export async function engine(): Promise<CryptoEngine> {
  return CryptoEngine.create();
}

export function identity(e: CryptoEngine, accountId: string, instanceId = uuidV7()): Identity {
  return e.createIdentity({ accountId, instanceId, signingKey: generateSigningKey() });
}

export const te = new TextEncoder();
export const td = new TextDecoder();
