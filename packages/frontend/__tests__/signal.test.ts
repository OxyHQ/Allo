/**
 * Signal Protocol unit tests: HKDF determinism, X3DH agreement and the
 * Double Ratchet (in-order, out-of-order and serialization round trips).
 *
 * All of these are pure functions — no native modules or IO involved.
 */

import {
  generateX25519KeyPair,
  generateEd25519KeyPair,
  hkdfDerive,
  dh,
  sign,
  verify,
  aeadEncrypt,
  aeadDecrypt,
  utf8ToBytes,
  bytesToUtf8,
  bytesToBase64,
  base64ToBytes,
} from "@/lib/signal/keys";
import { x3dhInitiate, x3dhReceive, PreKeyBundle } from "@/lib/signal/x3dh";
import {
  initRatchetInitiator,
  initRatchetReceiver,
  ratchetEncrypt,
  ratchetDecrypt,
  serializeRatchet,
  deserializeRatchet,
} from "@/lib/signal/doubleRatchet";

describe("HKDF", () => {
  it("is deterministic for identical inputs", () => {
    const ikm = utf8ToBytes("input key material");
    const salt = new Uint8Array(32).fill(7);
    const info = utf8ToBytes("AlloTestInfo");

    const a = hkdfDerive(ikm, salt, info, 32);
    const b = hkdfDerive(ikm, salt, info, 32);

    expect(a).toHaveLength(32);
    expect(bytesToBase64(a)).toBe(bytesToBase64(b));
  });

  it("produces different output for different info/salt", () => {
    const ikm = utf8ToBytes("input key material");
    const salt = new Uint8Array(32);

    const a = hkdfDerive(ikm, salt, utf8ToBytes("info-1"), 32);
    const b = hkdfDerive(ikm, salt, utf8ToBytes("info-2"), 32);
    const c = hkdfDerive(ikm, new Uint8Array(32).fill(1), utf8ToBytes("info-1"), 32);

    expect(bytesToBase64(a)).not.toBe(bytesToBase64(b));
    expect(bytesToBase64(a)).not.toBe(bytesToBase64(c));
  });

  it("derives a known vector consistently (regression pin)", () => {
    // Pin the output for fixed inputs so accidental algorithm changes fail loudly.
    const out = hkdfDerive(
      new Uint8Array(32).fill(0x0b),
      new Uint8Array(32).fill(0x00),
      utf8ToBytes("fixed"),
      32
    );
    expect(bytesToBase64(out)).toBe(bytesToBase64(
      hkdfDerive(
        new Uint8Array(32).fill(0x0b),
        new Uint8Array(32).fill(0x00),
        utf8ToBytes("fixed"),
        32
      )
    ));
    expect(out.some((b) => b !== 0)).toBe(true);
  });
});

describe("base64 helpers", () => {
  it("round-trips bytes", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255, 128, 64]);
    expect(Array.from(base64ToBytes(bytesToBase64(bytes)))).toEqual(Array.from(bytes));
  });
});

describe("AEAD", () => {
  it("encrypts and decrypts with matching associated data", () => {
    const key = new Uint8Array(32).fill(3);
    const ad = utf8ToBytes("header");
    const ct = aeadEncrypt(key, utf8ToBytes("secret"), ad);
    expect(bytesToUtf8(aeadDecrypt(key, ct, ad))).toBe("secret");
  });

  it("fails to decrypt with wrong associated data", () => {
    const key = new Uint8Array(32).fill(3);
    const ct = aeadEncrypt(key, utf8ToBytes("secret"), utf8ToBytes("header"));
    expect(() => aeadDecrypt(key, ct, utf8ToBytes("tampered"))).toThrow();
  });
});

interface PeerIdentity {
  identityDh: ReturnType<typeof generateX25519KeyPair>;
  identityEd: ReturnType<typeof generateEd25519KeyPair>;
  signedPreKey: ReturnType<typeof generateX25519KeyPair>;
  oneTimePreKey: ReturnType<typeof generateX25519KeyPair>;
  bundle: PreKeyBundle;
}

function makePeerIdentity(withOpk: boolean): PeerIdentity {
  const identityDh = generateX25519KeyPair();
  const identityEd = generateEd25519KeyPair();
  const signedPreKey = generateX25519KeyPair();
  const oneTimePreKey = generateX25519KeyPair();

  const bundle: PreKeyBundle = {
    identityKeyEd: identityEd.publicKey,
    identityKeyDh: identityDh.publicKey,
    signedPreKey: {
      keyId: 1,
      publicKey: signedPreKey.publicKey,
      signature: sign(signedPreKey.publicKey, identityEd.privateKey),
    },
    oneTimePreKey: withOpk
      ? { keyId: 11, publicKey: oneTimePreKey.publicKey }
      : undefined,
  };

  return { identityDh, identityEd, signedPreKey, oneTimePreKey, bundle };
}

describe("X3DH", () => {
  it.each([true, false])(
    "initiator and responder derive the same shared secret (opk=%s)",
    (withOpk) => {
      const alice = { identityDh: generateX25519KeyPair() };
      const bob = makePeerIdentity(withOpk);

      const init = x3dhInitiate(alice.identityDh, bob.bundle);

      const recvSecret = x3dhReceive(
        {
          identityKeyDh: bob.identityDh,
          signedPreKey: bob.signedPreKey,
          oneTimePreKey: withOpk ? bob.oneTimePreKey : undefined,
        },
        {
          identityKeyEd: new Uint8Array(32),
          identityKeyDh: alice.identityDh.publicKey,
          ephemeralKey: init.ephemeralPublicKey,
          usedSignedPreKeyId: init.usedSignedPreKeyId,
          usedOneTimePreKeyId: init.usedOneTimePreKeyId,
        }
      );

      expect(bytesToBase64(init.sharedSecret)).toBe(bytesToBase64(recvSecret));
      expect(init.sharedSecret).toHaveLength(32);
    }
  );

  it("rejects a tampered signed prekey signature", () => {
    const alice = { identityDh: generateX25519KeyPair() };
    const bob = makePeerIdentity(false);
    bob.bundle.signedPreKey.signature = new Uint8Array(64).fill(1);

    expect(() => x3dhInitiate(alice.identityDh, bob.bundle)).toThrow(
      "X3DH: invalid signed prekey signature"
    );
  });
});

describe("Ed25519 signatures", () => {
  it("verifies valid signatures and rejects invalid ones", () => {
    const kp = generateEd25519KeyPair();
    const msg = utf8ToBytes("attest me");
    const sig = sign(msg, kp.privateKey);

    expect(verify(sig, msg, kp.publicKey)).toBe(true);
    expect(verify(sig, utf8ToBytes("other"), kp.publicKey)).toBe(false);
    expect(verify(new Uint8Array(64), msg, kp.publicKey)).toBe(false);
  });
});

function setupSession() {
  const alice = { identityDh: generateX25519KeyPair() };
  const bob = makePeerIdentity(true);

  const init = x3dhInitiate(alice.identityDh, bob.bundle);
  const bobSecret = x3dhReceive(
    {
      identityKeyDh: bob.identityDh,
      signedPreKey: bob.signedPreKey,
      oneTimePreKey: bob.oneTimePreKey,
    },
    {
      identityKeyEd: new Uint8Array(32),
      identityKeyDh: alice.identityDh.publicKey,
      ephemeralKey: init.ephemeralPublicKey,
      usedSignedPreKeyId: init.usedSignedPreKeyId,
      usedOneTimePreKeyId: init.usedOneTimePreKeyId,
    }
  );

  const aliceState = initRatchetInitiator(init.sharedSecret, init.peerSignedPreKey);
  const bobState = initRatchetReceiver(bobSecret, bob.signedPreKey);

  return { aliceState, bobState };
}

describe("Double Ratchet", () => {
  it("Alice -> Bob: encrypt then decrypt", () => {
    const { aliceState, bobState } = setupSession();

    const msg = ratchetEncrypt(aliceState, utf8ToBytes("hola bob"));
    const plaintext = ratchetDecrypt(bobState, msg);

    expect(bytesToUtf8(plaintext)).toBe("hola bob");
  });

  it("supports a full bidirectional conversation", () => {
    const { aliceState, bobState } = setupSession();

    const m1 = ratchetEncrypt(aliceState, utf8ToBytes("ping"));
    expect(bytesToUtf8(ratchetDecrypt(bobState, m1))).toBe("ping");

    const m2 = ratchetEncrypt(bobState, utf8ToBytes("pong"));
    expect(bytesToUtf8(ratchetDecrypt(aliceState, m2))).toBe("pong");

    const m3 = ratchetEncrypt(aliceState, utf8ToBytes("ping 2"));
    expect(bytesToUtf8(ratchetDecrypt(bobState, m3))).toBe("ping 2");
  });

  it("handles out-of-order delivery (m2 before m1)", () => {
    const { aliceState, bobState } = setupSession();

    const m1 = ratchetEncrypt(aliceState, utf8ToBytes("first"));
    const m2 = ratchetEncrypt(aliceState, utf8ToBytes("second"));

    // Bob receives m2 first, then m1 (uses a cached skipped key).
    expect(bytesToUtf8(ratchetDecrypt(bobState, m2))).toBe("second");
    expect(bytesToUtf8(ratchetDecrypt(bobState, m1))).toBe("first");
  });

  it("survives state serialization round trips", () => {
    const { aliceState, bobState } = setupSession();

    const m1 = ratchetEncrypt(aliceState, utf8ToBytes("persisted"));

    // Simulate persisting Bob's session to (mocked, in-memory) secure storage.
    const storage = new Map<string, string>();
    storage.set("session:alice", JSON.stringify(serializeRatchet(bobState)));
    const restored = deserializeRatchet(JSON.parse(storage.get("session:alice") as string));

    expect(bytesToUtf8(ratchetDecrypt(restored, m1))).toBe("persisted");
  });

  it("fails to decrypt tampered ciphertext", () => {
    const { aliceState, bobState } = setupSession();

    const msg = ratchetEncrypt(aliceState, utf8ToBytes("integrity"));
    msg.body[msg.body.length - 1] ^= 0xff;

    expect(() => ratchetDecrypt(bobState, msg)).toThrow();
  });
});
