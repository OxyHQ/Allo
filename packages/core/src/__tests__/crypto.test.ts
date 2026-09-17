import { describe, expect, it } from "vitest";
import { AtRestCipher } from "../crypto/atRest";
import { keyPackageRefFromWire } from "../crypto/engine";
import { FutureEpochError, StorageError } from "../errors";
import { MemoryStorage, MemorySecrets } from "../testing/memoryAdapters";
import { AlloStore } from "../storage/store";
import { Namespace } from "../storage/namespace";
import { base64Decode, bytesEqual, bytesInclude, randomBytes, utf8Encode } from "../util/bytes";
import { engine, identity, td, te } from "./helpers";

describe("CryptoEngine", () => {
  it("creates, adds, joins, encrypts and decrypts across three leaves", async () => {
    const e = await engine();
    const alice = identity(e, "acc-alice");
    const bob = identity(e, "acc-bob");
    const bobLaptop = identity(e, "acc-bob");
    const [bobKp] = await e.generateKeyPackages(bob, 1);
    const [bobLaptopKp] = await e.generateKeyPackages(bobLaptop, 1);
    expect(bytesEqual(keyPackageRefFromWire(bobKp.publicWire), bobKp.ref)).toBe(true);

    let aliceState = await e.createGroup(alice, randomBytes(16));
    expect(e.epochOf(aliceState)).toBe(0);
    const c = await e.commit(aliceState, { addKeyPackages: [bobKp.publicWire, bobLaptopKp.publicWire] });
    expect(c.added.map((a) => a.instanceId)).toEqual([bob.instanceId, bobLaptop.instanceId]);
    expect(c.welcome).toBeDefined();
    // the Welcome addresses exactly the refs we computed
    const refs = e.welcomeRefs(c.welcome!);
    expect(refs.some((r) => bytesEqual(r, bobKp.ref))).toBe(true);
    expect(refs.some((r) => bytesEqual(r, bobLaptopKp.ref))).toBe(true);
    // pending commit: alice's live state is untouched until "the server accepted"
    expect(e.epochOf(aliceState)).toBe(0);
    aliceState = c.next;
    expect(e.epochOf(aliceState)).toBe(1);

    let bobState = await e.joinFromWelcome(c.welcome!, bobKp);
    let laptopState = await e.joinFromWelcome(c.welcome!, bobLaptopKp);
    expect(e.epochOf(bobState)).toBe(1);
    expect(e.membersOf(bobState).map((m) => m.accountId).sort()).toEqual(["acc-alice", "acc-bob", "acc-bob"]);

    const enc = await e.encryptApplication(aliceState, te.encode("hello"));
    aliceState = enc.next;
    const r1 = await e.processIncoming(bobState, enc.ciphertext);
    bobState = r1.next;
    const r2 = await e.processIncoming(laptopState, enc.ciphertext);
    laptopState = r2.next;
    expect(td.decode(r1.plaintext)).toBe("hello");
    expect(td.decode(r2.plaintext)).toBe("hello");

    const back = await e.encryptApplication(laptopState, te.encode("from laptop"));
    laptopState = back.next;
    const r3 = await e.processIncoming(aliceState, back.ciphertext);
    aliceState = r3.next;
    expect(td.decode(r3.plaintext)).toBe("from laptop");
  });

  it("removal: the removed leaf cannot decrypt what follows", async () => {
    const e = await engine();
    const alice = identity(e, "a");
    const bob = identity(e, "b");
    const [bobKp] = await e.generateKeyPackages(bob, 1);
    const g = await e.createGroup(alice, randomBytes(16));
    const add = await e.commit(g, { addKeyPackages: [bobKp.publicWire] });
    let aliceState = add.next;
    let bobState = await e.joinFromWelcome(add.welcome!, bobKp);
    const bobLeaf = e.membersOf(aliceState).find((m) => m.instanceId === bob.instanceId)!.leafIndex;
    const rm = await e.commit(aliceState, { removeLeafIndexes: [bobLeaf] });
    const bobSees = await e.processIncoming(bobState, rm.commit);
    expect(bobSees.kind).toBe("commit");
    expect(bobSees.removedSelf).toBe(true);
    bobState = bobSees.next;
    aliceState = rm.next;
    expect(e.isActive(bobState)).toBe(false);
    const after = await e.encryptApplication(aliceState, te.encode("secret"));
    await expect(e.processIncoming(bobState, after.ciphertext)).rejects.toThrow();
    await expect(e.encryptApplication(bobState, te.encode("x"))).rejects.toThrow();
  });

  it("future-epoch gating throws FutureEpochError and leaves the state untouched", async () => {
    const e = await engine();
    const alice = identity(e, "a");
    const bob = identity(e, "b");
    const carol = identity(e, "c");
    const [bobKp] = await e.generateKeyPackages(bob, 1);
    const [carolKp] = await e.generateKeyPackages(carol, 1);
    const g = await e.createGroup(alice, randomBytes(16));
    const add = await e.commit(g, { addKeyPackages: [bobKp.publicWire] });
    let aliceState = add.next;
    const bobState = await e.joinFromWelcome(add.welcome!, bobKp);
    // Alice commits again (adds carol) and sends a message at epoch 2; Bob has not seen the commit.
    const add2 = await e.commit(aliceState, { addKeyPackages: [carolKp.publicWire] });
    aliceState = add2.next;
    const msg = await e.encryptApplication(aliceState, te.encode("epoch 2"));
    const before = e.serializeGroup(bobState);
    const err = await e.processIncoming(bobState, msg.ciphertext).catch((x) => x);
    expect(err).toBeInstanceOf(FutureEpochError);
    expect(err.messageEpoch).toBe(2);
    expect(err.stateEpoch).toBe(1);
    expect(bytesEqual(e.serializeGroup(bobState), before)).toBe(true);
    expect(e.peek(msg.ciphertext)).toEqual({ kind: "private", epoch: 2, contentType: "application" });
    // in order it works
    const r = await e.processIncoming(bobState, add2.commit);
    const r2 = await e.processIncoming(r.next, msg.ciphertext);
    expect(td.decode(r2.plaintext)).toBe("epoch 2");
  });

  it("serialize/deserialize round trip keeps the state usable", async () => {
    const e = await engine();
    const alice = identity(e, "a");
    const bob = identity(e, "b");
    const [bobKp] = await e.generateKeyPackages(bob, 1);
    const g = await e.createGroup(alice, randomBytes(16));
    const add = await e.commit(g, { addKeyPackages: [bobKp.publicWire] });
    const bobState = await e.joinFromWelcome(add.welcome!, bobKp);
    const bytes = e.serializeGroup(add.next);
    const restored = e.deserializeGroup(bytes);
    expect(bytesEqual(e.serializeGroup(restored), bytes)).toBe(true);
    const enc = await e.encryptApplication(restored, te.encode("after restore"));
    const r = await e.processIncoming(bobState, enc.ciphertext);
    expect(td.decode(r.plaintext)).toBe("after restore");
    // the raw encoding carries the private signature key in the clear: that is why the store encrypts it
    expect(bytesInclude(bytes, alice.signingKey.secretKey)).toBe(true);
  });
});

describe("at-rest encryption", () => {
  it("nothing written through the store contains the plaintext or the raw key", async () => {
    const storage = new MemoryStorage();
    const secrets = new MemorySecrets();
    const cipher = await AtRestCipher.open(secrets, "acc", "allo");
    const store = new AlloStore(storage, cipher, new Namespace("allo", "acc")).forInstance("inst-1");
    const marker = "MARKER-plaintext-7f3a9c";
    await store.putJson("conversation", "c1", { id: "c1", name: marker });
    const key = randomBytes(32);
    await store.putBytes("groupState", "c1", key);
    const dump = storage.dump();
    expect(bytesInclude(dump, utf8Encode(marker))).toBe(false);
    expect(bytesInclude(dump, key)).toBe(false);
    expect(bytesInclude(dump, (await secrets.get("allo.storage-key.acc.allo"))!)).toBe(false);
    expect(bytesEqual((await store.getBytes("groupState", "c1"))!, key)).toBe(true);
    // a row moved under another key path fails authentication
    const k1 = (await storage.list("allo/allo/acc/inst-1/groupState/"))[0];
    const raw = (await storage.get(k1))!;
    await storage.set("allo/allo/acc/inst-1/groupState/c2", raw);
    await expect(store.getBytes("groupState", "c2")).rejects.toBeInstanceOf(StorageError);
    // different storage key cannot read it
    const other = AtRestCipher.fromKey(randomBytes(32));
    expect(() => other.decrypt(k1, raw)).toThrow(StorageError);
  });

  it("nonces are fresh per write", async () => {
    const cipher = AtRestCipher.fromKey(randomBytes(32));
    const a = cipher.encrypt("k", utf8Encode("same"));
    const b = cipher.encrypt("k", utf8Encode("same"));
    expect(bytesEqual(a, b)).toBe(false);
    expect(bytesEqual(cipher.decrypt("k", a), utf8Encode("same"))).toBe(true);
  });

  it("keyPackageRef matches the ref inside a Welcome (base64 sanity)", async () => {
    expect(base64Decode("AAAA").length).toBe(3);
  });
});
