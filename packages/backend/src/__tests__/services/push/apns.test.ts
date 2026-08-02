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
import type { PushNotificationDevice, PushNotificationRequest } from "../../../services/push/notification";

/**
 * iOS delivery.
 *
 * The payload assertions are the ones that matter for privacy — the message
 * itself is never in scope here, so what is asserted is that only coordinates
 * and the client's own words travel. The reason mapping is the one that matters
 * for keeping people's notifications alive.
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

const DEVICE: PushNotificationDevice = {
  appId: "so.oxy.allo.ios",
  pushkey: "device-token-aaa",
  fallback: undefined,
  sound: undefined,
};

const ALERT: PushNotificationRequest = {
  eventId: "$an-event-id",
  roomId: "!a-room:allo.you",
  unreadCount: 3,
  highPriority: true,
  devices: [DEVICE],
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

  it("carries the client's own words, the coordinates, and nothing else", async () => {
    const { transport, sent } = recordingTransport(ACCEPTED);
    await createApnsSender(CREDENTIALS, TOKENS, transport).send(
      [{ ...DEVICE, fallback: { title: "Allo", body: "Nuevo mensaje" }, sound: "default" }],
      ALERT,
    );

    expect(payloadOf(sent[0])).toEqual({
      aps: {
        alert: { title: "Allo", body: "Nuevo mensaje" },
        "mutable-content": 1,
        sound: "default",
        badge: 3,
        "thread-id": "!a-room:allo.you",
      },
      event_id: "$an-event-id",
      room_id: "!a-room:allo.you",
    });
  });

  it("is an alert at priority 10, collapsed on the event", async () => {
    const { transport, sent } = recordingTransport(ACCEPTED);
    await createApnsSender(CREDENTIALS, TOKENS, transport).send([DEVICE], ALERT);

    expect(sent[0]?.headers["apns-push-type"]).toBe("alert");
    expect(sent[0]?.headers["apns-priority"]).toBe("10");
    expect(sent[0]?.headers["apns-collapse-id"]).toBe("$an-event-id");
  });

  it("is a background push at priority 5 when there is nothing to announce", async () => {
    const { transport, sent } = recordingTransport(ACCEPTED);
    await createApnsSender(CREDENTIALS, TOKENS, transport).send([DEVICE], {
      eventId: undefined,
      roomId: undefined,
      unreadCount: 0,
      highPriority: false,
      devices: [DEVICE],
    });

    // Apple refuses a background notification sent at priority 10 outright.
    expect(sent[0]?.headers["apns-push-type"]).toBe("background");
    expect(sent[0]?.headers["apns-priority"]).toBe("5");
    expect(payloadOf(sent[0])).toEqual({ aps: { "content-available": 1, badge: 0 } });
  });

  it("leaves out a collapse id Apple would refuse for being too long", async () => {
    const { transport, sent } = recordingTransport(ACCEPTED);
    await createApnsSender(CREDENTIALS, TOKENS, transport).send([DEVICE], {
      ...ALERT,
      eventId: `$${"e".repeat(70)}`,
    });

    expect(sent[0]?.headers["apns-collapse-id"]).toBeUndefined();
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
  ])("rejects the pusher when the token is unambiguously gone (%s)", async (reason, status) => {
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
  ])("keeps the pusher for anything that might be our fault (%s)", async (reason, status) => {
    const { transport } = recordingTransport({ status, reason });

    expect(await createApnsSender(CREDENTIALS, TOKENS, transport).send([DEVICE], ALERT)).toEqual([
      { kind: "failed", reason },
    ]);
  });

  it("keeps the pusher when the answer carried no reason to read", async () => {
    const { transport } = recordingTransport({ status: 500, reason: undefined });

    expect(await createApnsSender(CREDENTIALS, TOKENS, transport).send([DEVICE], ALERT)).toEqual([
      { kind: "failed", reason: "status 500" },
    ]);
  });

  it("keeps the pusher when the request never completed", async () => {
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
