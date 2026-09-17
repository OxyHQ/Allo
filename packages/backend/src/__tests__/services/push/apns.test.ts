import { createServer, type Http2Server } from "http2";
import type { AddressInfo } from "net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ApnsCredentials } from "../../../config/push";
import {
  createApnsSender,
  createHttp2ApnsTransport,
  type ApnsRequest,
  type ApnsResponse,
  type ApnsTransport,
} from "../../../services/push/apns";
import type { ApnsTokenProvider } from "../../../services/push/apnsAuth";
import type { PushDevice, PushNotification } from "../../../services/push/delivery";

/**
 * iOS delivery.
 *
 * The payload assertions are the ones that matter for privacy — the message
 * itself is never in scope here, so what is asserted is that only the caller's
 * words and coordinates travel. The reason mapping is the one that matters for
 * keeping people's notifications alive.
 *
 * The last group runs the real HTTP/2 client against a real HTTP/2 server. It is
 * worth the machinery: everything above it tests the sender against a transport
 * that cannot be wrong, and the transport is where the status code, the reason
 * body and the stream lifecycle actually live.
 */

const CREDENTIALS: ApnsCredentials = {
  keyId: "ABCD1234EF",
  teamId: "TEAM123456",
  privateKeyPem: "unused: the token provider is injected",
  topic: "so.oxy.allo",
  host: "https://api.push.apple.com",
};

const TOKENS: ApnsTokenProvider = { token: () => "a-provider-token" };

const DEVICE: PushDevice = { platform: "ios", token: "device-token-aaa" };

const ALERT: PushNotification = {
  title: "Allo",
  body: "New message",
  data: { conversation_id: "conv-1", event_id: "evt-1" },
};

function recordingTransport(response: ApnsResponse): {
  transport: ApnsTransport;
  sent: ApnsRequest[];
} {
  const sent: ApnsRequest[] = [];
  return {
    sent,
    transport: async (request) => {
      sent.push(request);
      return response;
    },
  };
}

const ACCEPTED: ApnsResponse = { status: 200, reason: undefined };

function payloadOf(request: ApnsRequest | undefined): Record<string, unknown> {
  const parsed: unknown = JSON.parse(request?.body ?? "{}");
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("an APNs body did not parse to an object");
  }
  return parsed as Record<string, unknown>;
}

describe("the request Apple is given", () => {
  it("addresses the device and authenticates with the provider token", async () => {
    const { transport, sent } = recordingTransport(ACCEPTED);
    await createApnsSender(CREDENTIALS, TOKENS, transport).send([DEVICE], ALERT);

    expect(sent[0]?.path).toBe("/3/device/device-token-aaa");
    expect(sent[0]?.headers.authorization).toBe("bearer a-provider-token");
    expect(sent[0]?.headers["apns-topic"]).toBe("so.oxy.allo");
  });

  it("carries the caller's words, the coordinates, and nothing else", async () => {
    const { transport, sent } = recordingTransport(ACCEPTED);
    await createApnsSender(CREDENTIALS, TOKENS, transport).send([DEVICE], ALERT);

    expect(payloadOf(sent[0])).toEqual({
      aps: {
        alert: { title: "Allo", body: "New message" },
        "mutable-content": 1,
      },
      conversation_id: "conv-1",
      event_id: "evt-1",
    });
  });

  it("is an alert at priority 10", async () => {
    const { transport, sent } = recordingTransport(ACCEPTED);
    await createApnsSender(CREDENTIALS, TOKENS, transport).send([DEVICE], ALERT);

    expect(sent[0]?.headers["apns-push-type"]).toBe("alert");
    expect(sent[0]?.headers["apns-priority"]).toBe("10");
  });

  it("never lets a data key overwrite Apple's own block", async () => {
    /**
     * `aps` is where Apple reads the alert from. A caller's `data.aps` spread
     * beside it would replace the alert with a string, and Apple would answer
     * `PayloadTooLarge` or show nothing — so the key is dropped, not merged.
     */
    const { transport, sent } = recordingTransport(ACCEPTED);
    await createApnsSender(CREDENTIALS, TOKENS, transport).send([DEVICE], {
      ...ALERT,
      data: { aps: "overwritten", conversation_id: "conv-1" },
    });

    const payload = payloadOf(sent[0]);
    expect(payload.aps).toEqual({
      alert: { title: "Allo", body: "New message" },
      "mutable-content": 1,
    });
    expect(payload.conversation_id).toBe("conv-1");
  });
});

describe("what Apple says about a token", () => {
  it("reports a 200 as delivered", async () => {
    const { transport } = recordingTransport(ACCEPTED);

    expect(await createApnsSender(CREDENTIALS, TOKENS, transport).send([DEVICE], ALERT)).toEqual([
      { kind: "delivered" },
    ]);
  });

  it.each([
    ["BadDeviceToken", 400],
    ["Unregistered", 410],
    ["DeviceTokenNotForTopic", 400],
  ])("rejects the token when it is unambiguously gone (%s)", async (reason, status) => {
    const { transport } = recordingTransport({ status, reason });

    expect(await createApnsSender(CREDENTIALS, TOKENS, transport).send([DEVICE], ALERT)).toEqual([
      { kind: "rejected", reason },
    ]);
  });

  it.each([
    /** Every one of these is about our key, our topic or our payload. */
    ["ExpiredProviderToken", 403],
    ["InvalidProviderToken", 403],
    ["BadTopic", 400],
    ["TopicDisallowed", 400],
    ["PayloadTooLarge", 413],
    ["TooManyRequests", 429],
    ["ServiceUnavailable", 503],
  ])("keeps the token for anything that might be our fault (%s)", async (reason, status) => {
    const { transport } = recordingTransport({ status, reason });

    expect(await createApnsSender(CREDENTIALS, TOKENS, transport).send([DEVICE], ALERT)).toEqual([
      { kind: "failed", reason },
    ]);
  });

  it("keeps the token when the answer carried no reason to read", async () => {
    const { transport } = recordingTransport({ status: 500, reason: undefined });

    expect(await createApnsSender(CREDENTIALS, TOKENS, transport).send([DEVICE], ALERT)).toEqual([
      { kind: "failed", reason: "status 500" },
    ]);
  });

  it("keeps the token when the request never completed", async () => {
    const transport: ApnsTransport = async () => {
      throw new Error("the connection was reset");
    };

    expect(await createApnsSender(CREDENTIALS, TOKENS, transport).send([DEVICE], ALERT)).toEqual([
      { kind: "failed", reason: "the connection was reset" },
    ]);
  });
});

describe("the HTTP/2 transport, against a real server", () => {
  let server: Http2Server;
  let origin: string;
  let received: { path: string; authorization: string; body: string } | undefined;
  let answer: { status: number; body: string } = { status: 200, body: "" };

  beforeAll(async () => {
    server = createServer();
    server.on("stream", (stream, headers) => {
      let body = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => {
        body += chunk;
      });
      stream.on("end", () => {
        received = {
          path: String(headers[":path"] ?? ""),
          authorization: String(headers.authorization ?? ""),
          body,
        };
        stream.respond({ ":status": answer.status });
        stream.end(answer.body);
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    origin = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it("sends the request and reads a 200 back", async () => {
    answer = { status: 200, body: "" };
    const transport = createHttp2ApnsTransport(origin);

    const response = await transport.send({
      path: "/3/device/device-token-aaa",
      headers: { authorization: "bearer a-provider-token" },
      body: JSON.stringify({ aps: { alert: { title: "Allo", body: "New message" } } }),
    });
    transport.close();

    expect(response).toEqual({ status: 200, reason: undefined });
    expect(received?.path).toBe("/3/device/device-token-aaa");
    expect(received?.authorization).toBe("bearer a-provider-token");
    expect(JSON.parse(received?.body ?? "{}")).toHaveProperty("aps");
  });

  it("reads Apple's reason out of an error body", async () => {
    answer = { status: 410, body: JSON.stringify({ reason: "Unregistered" }) };
    const transport = createHttp2ApnsTransport(origin);

    const response = await transport.send({
      path: "/3/device/device-token-aaa",
      headers: {},
      body: "{}",
    });
    transport.close();

    expect(response).toEqual({ status: 410, reason: "Unregistered" });
  });

  it("survives a body that is not the JSON Apple documents", async () => {
    answer = { status: 503, body: "<html>service unavailable</html>" };
    const transport = createHttp2ApnsTransport(origin);

    const response = await transport.send({
      path: "/3/device/device-token-aaa",
      headers: {},
      body: "{}",
    });
    transport.close();

    expect(response).toEqual({ status: 503, reason: undefined });
  });

  it("reuses one connection across notifications, as Apple asks providers to", async () => {
    answer = { status: 200, body: "" };
    let sessions = 0;
    server.on("session", () => {
      sessions += 1;
    });
    const transport = createHttp2ApnsTransport(origin);

    await transport.send({ path: "/3/device/a", headers: {}, body: "{}" });
    await transport.send({ path: "/3/device/b", headers: {}, body: "{}" });
    transport.close();

    expect(sessions).toBe(1);
  });
});
