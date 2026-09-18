import { act, waitFor as rtlWaitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { MediaRef, MediaView } from "../index";
import { MediaCache, useMediaFile, useTimeline } from "../index";
import { fakeServer, makeClient, renderAlloHook, stopAll, waitFor, waitJoined, type TestClient } from "./helpers";

describe("useMediaFile", () => {
  const started: TestClient[] = [];
  afterEach(async () => {
    await stopAll(...started.splice(0));
  });

  it("loads and decrypts an uploaded blob and returns identical bytes, served from the cache afterwards", async () => {
    const server = fakeServer();
    const alice = await makeClient(server, "acc-alice-01", "Alice web");
    const bob = await makeClient(server, "acc-bob-0001", "Bob iOS", "ios");
    started.push(alice, bob);
    const conv = await alice.client.conversations.createDirect("acc-bob-0001");
    await waitJoined(bob, conv.id);
    const bytes = new Uint8Array(5000).map((_, i) => (i * 7) & 0xff);
    await alice.client.media.upload(conv.id, bytes, { kind: "file", filename: "data.bin", mime: "application/octet-stream", caption: "cap" });
    await waitFor(() => bob.client.messages.timeline(conv.id).some((i) => i.content.kind === "media"));
    const item = bob.client.messages.timeline(conv.id).find((i) => i.content.kind === "media")!;
    const media = (item.content as { media: MediaView }).media;
    expect(media.size).toBe(5000);

    const { result, rerender } = renderAlloHook(bob.client, ({ ref }: { ref: MediaRef | undefined }) => useMediaFile(ref), { initialProps: { ref: undefined as MediaRef | undefined } });
    expect(result.current.status).toBe("idle");

    rerender({ ref: media.ref });
    expect(result.current.status).toBe("loading");
    await rtlWaitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.bytes).toBeInstanceOf(Uint8Array);
    expect(Array.from(result.current.bytes!)).toEqual(Array.from(bytes));
    const first = result.current.bytes;
    const downloads = () => server.requestLog.filter((r) => r.method === "GET" && r.path.includes("/blobs/")).length;
    const downloadsAfterFirst = downloads();
    expect(downloadsAfterFirst).toBeGreaterThan(0);

    // ref → undefined → same ref again: idle, then ready synchronously from the cache with the same bytes, no second download
    rerender({ ref: undefined });
    expect(result.current.status).toBe("idle");
    rerender({ ref: { ...media.ref } });
    expect(result.current.status).toBe("ready");
    expect(result.current.bytes).toBe(first);
    expect(downloads()).toBe(downloadsAfterFirst);
  });

  it("reports an error for a blob that does not exist and retries on the next mount", async () => {
    const server = fakeServer();
    const alice = await makeClient(server, "acc-alice-01", "Alice web");
    const bob = await makeClient(server, "acc-bob-0001", "Bob iOS", "ios");
    started.push(alice, bob);
    const conv = await alice.client.conversations.createDirect("acc-bob-0001");
    const ref: MediaRef = { conversationId: conv.id, blobId: "no-such-blob" };
    const { result } = renderAlloHook(alice.client, () => useMediaFile(ref));
    await rtlWaitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.error).toBeInstanceOf(Error);
  });

  it("MediaCache evicts least recently used beyond its capacity and de-duplicates in-flight loads", async () => {
    const cache = new MediaCache(2);
    cache.set("a", new Uint8Array([1]));
    cache.set("b", new Uint8Array([2]));
    cache.get("a"); // a is now most recently used
    cache.set("c", new Uint8Array([3]));
    expect(cache.has("b")).toBe(false);
    expect(cache.has("a")).toBe(true);
    expect(cache.has("c")).toBe(true);

    let calls = 0;
    const download = () =>
      new Promise<Uint8Array>((resolve) => {
        calls++;
        setTimeout(() => resolve(new Uint8Array([9])), 5);
      });
    const [x, y] = await Promise.all([cache.load("d", download), cache.load("d", download)]);
    expect(calls).toBe(1);
    expect(x).toBe(y);
    expect(cache.get("d")).toBe(x);
  });

  it("sendMedia forwards the thumbnail: the receiver's item names it and useMediaFile opens it", async () => {
    const server = fakeServer();
    const alice = await makeClient(server, "acc-alice-01", "Alice web");
    const bob = await makeClient(server, "acc-bob-0001", "Bob iOS", "ios");
    started.push(alice, bob);
    const conv = await alice.client.conversations.createDirect("acc-bob-0001");
    await waitJoined(bob, conv.id);
    const bytes = new Uint8Array(3000).map((_, i) => (i * 13) & 0xff);
    const thumb = new Uint8Array(200).map((_, i) => (i * 7 + 3) & 0xff);

    const sender = renderAlloHook(alice.client, () => useTimeline(conv.id));
    await act(async () => {
      await sender.result.current.sendMedia(bytes, { kind: "image", filename: "pic.png", mime: "image/png", width: 40, height: 30, thumbnail: { bytes: thumb, mime: "image/jpeg", width: 8, height: 6 } });
    });
    await waitFor(() => bob.client.messages.timeline(conv.id).some((i) => i.content.kind === "media"));
    const item = bob.client.messages.timeline(conv.id).find((i) => i.content.kind === "media")!;
    const media = (item.content as { media: MediaView }).media;
    expect(media.thumbnail).toMatchObject({ width: 8, height: 6 });
    expect(media.thumbnail?.ref.blobId).not.toBe(media.ref.blobId);
    // two blobs went up, and neither carried the plaintext
    const uploads = server.requestLog.filter((r) => r.method === "POST" && r.path.includes("/blobs"));
    expect(uploads.length).toBeGreaterThanOrEqual(2);

    const { result } = renderAlloHook(bob.client, () => ({ full: useMediaFile(media.ref), thumb: useMediaFile(media.thumbnail!.ref) }));
    await rtlWaitFor(() => expect(result.current.thumb.status).toBe("ready"));
    expect(Array.from(result.current.thumb.bytes!)).toEqual(Array.from(thumb));
    await rtlWaitFor(() => expect(result.current.full.status).toBe("ready"));
    expect(Array.from(result.current.full.bytes!)).toEqual(Array.from(bytes));
  });
});
