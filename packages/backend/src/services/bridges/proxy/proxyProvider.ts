import http from "http";
import https from "https";
import net from "net";
import tls from "tls";
import { bridgesConfig, type BridgeProxyProviderConfig } from "../../../config/bridges";

/**
 * The proxy provider seam (docs/matrix/bridges.md §8.2).
 *
 * An interface rather than a concrete client because no provider has been
 * contracted: §12.1 and §12.2 record that neither prices nor the exact username
 * syntax have been verified against any vendor's documentation, and the design
 * is explicit that the syntax "hay que confirmarlo contra la documentación del
 * que se contrate". Hardcoding one vendor's format would be inventing a fact.
 *
 * So the shape below is fixed and the format is configuration.
 */

/** What composing a proxy URL actually needs. Never the whole lease document. */
export interface ProxyLeaseDescriptor {
  readonly countryCode: string;
  readonly regionCode?: string;
  readonly sessionSeed: string;
}

export interface ProxyExitObservation {
  readonly ip: string;
  /** ISO 3166-1 alpha-2, as the echo endpoint reported it. */
  readonly country: string;
}

export interface ProxyProvider {
  readonly id: string;
  supportsCountry(countryCode: string): boolean;
  composeUrl(lease: ProxyLeaseDescriptor): string;
  verifyExit(lease: ProxyLeaseDescriptor): Promise<ProxyExitObservation>;
}

export class ProxyProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProxyProviderError";
  }
}

/** No echo endpoint configured, so §8.3 rule 5 cannot be carried out. */
export class ProxyVerificationUnavailableError extends ProxyProviderError {
  constructor(message: string) {
    super(message);
    this.name = "ProxyVerificationUnavailableError";
  }
}

interface ParsedGateway {
  readonly protocol: "http:" | "https:";
  readonly host: string;
  readonly port: number;
}

/**
 * Gateways must be HTTP proxies, and that is a deliberate restriction.
 *
 * The exit verification below tunnels with HTTP `CONNECT`, which a SOCKS5
 * gateway does not speak. Accepting a `socks5://` gateway would produce a
 * deployment where composing a URL works and VERIFYING it never does — and
 * unverified exit geography is the failure §8.3 rule 5 exists to prevent: a
 * provider misconfiguration that surfaces three weeks later as a wave of bans
 * with no apparent cause. Refusing at parse time keeps the two capabilities from
 * drifting apart.
 */
function parseGateway(gateway: string): ParsedGateway {
  const candidate = /^[a-z0-9+.-]+:\/\//i.test(gateway) ? gateway : `http://${gateway}`;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new ProxyProviderError(
      `ALLO_BRIDGE_PROXY_GATEWAY is not a usable gateway: ${gateway}`,
    );
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ProxyProviderError(
      `ALLO_BRIDGE_PROXY_GATEWAY must be an http(s) proxy — ${url.protocol} cannot be exit-verified, ` +
        "and an exit that cannot be verified is one that will egress from the wrong country undetected",
    );
  }
  if (!url.port) {
    throw new ProxyProviderError("ALLO_BRIDGE_PROXY_GATEWAY must include a port");
  }

  return { protocol: url.protocol, host: url.hostname, port: Number(url.port) };
}

/**
 * Fills `{country}`, `{region}` and `{session}` into the provider's username
 * format.
 *
 * The config layer has already refused a template missing `{country}` or
 * `{session}`: a template without the first composes a URL the provider happily
 * accepts and then egresses from wherever it likes, and one without the second
 * gives two users the same session — which is §8.3 rule 7 broken silently, the
 * exact correlation per-user proxies are bought to avoid.
 */
function composeUsername(template: string, lease: ProxyLeaseDescriptor): string {
  return template
    .replace(/\{country\}/g, lease.countryCode.toLowerCase())
    .replace(/\{region\}/g, (lease.regionCode ?? "").toLowerCase())
    .replace(/\{session\}/g, lease.sessionSeed);
}

/**
 * The provider Allo ships: one gateway, credentials from the environment, and
 * country plus session encoded into the username by a configured template.
 *
 * It covers the shape §8.2 describes as the most widespread
 * (`user-country-xx-session-yyy:password@gateway:port`) without naming a vendor
 * or assuming its punctuation.
 */
export function createTemplateProxyProvider(
  config: BridgeProxyProviderConfig,
): ProxyProvider {
  const gateway = parseGateway(config.gateway);
  const countries = config.countries
    ? new Set(config.countries.map((code) => code.toUpperCase()))
    : undefined;

  function composeUrl(lease: ProxyLeaseDescriptor): string {
    if (!supportsCountry(lease.countryCode)) {
      throw new ProxyProviderError(
        `proxy provider ${config.providerId} does not serve ${lease.countryCode}`,
      );
    }
    const username = encodeURIComponent(composeUsername(config.usernameTemplate, lease));
    const password = encodeURIComponent(config.password);
    return `${gateway.protocol}//${username}:${password}@${gateway.host}:${gateway.port}`;
  }

  /**
   * An empty allowlist means "unknown", not "none".
   *
   * `ALLO_BRIDGE_PROXY_COUNTRIES` is optional because a provider's coverage list
   * is theirs, not ours; when it is absent the composed URL is attempted and the
   * exit verification is what catches a country the provider does not actually
   * serve. When it IS present it is authoritative, and a lease outside it is
   * refused before any packet leaves.
   */
  function supportsCountry(countryCode: string): boolean {
    if (!/^[A-Za-z]{2}$/.test(countryCode)) return false;
    if (!countries) return true;
    return countries.has(countryCode.toUpperCase());
  }

  async function verifyExit(lease: ProxyLeaseDescriptor): Promise<ProxyExitObservation> {
    if (!config.echoUrl) {
      throw new ProxyVerificationUnavailableError(
        "ALLO_BRIDGE_PROXY_ECHO_URL is not configured, so the exit country cannot be checked",
      );
    }
    const body = await fetchThroughProxy(
      composeUrl(lease),
      config.echoUrl,
      bridgesConfig().httpTimeoutMs,
    );

    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      throw new ProxyProviderError("proxy echo endpoint did not return JSON");
    }
    if (typeof payload !== "object" || payload === null) {
      throw new ProxyProviderError("proxy echo endpoint did not return a JSON object");
    }

    const ip: unknown = Reflect.get(payload, "ip");
    const country: unknown = Reflect.get(payload, "country");
    if (typeof ip !== "string" || typeof country !== "string") {
      throw new ProxyProviderError(
        'proxy echo endpoint must return {"ip": string, "country": string}',
      );
    }
    return { ip, country: country.toUpperCase() };
  }

  return { id: config.providerId, supportsCountry, composeUrl, verifyExit };
}

/**
 * One GET through an HTTP proxy, tunnelled with `CONNECT`.
 *
 * `CONNECT` rather than an absolute-URI request even for plain HTTP targets, so
 * there is a single code path and the TLS case is not the untested one. Node's
 * own HTTP client parses the response — hand-rolling that parsing is how a
 * chunked body ends up half-read and a country ends up half-compared.
 */
async function fetchThroughProxy(
  proxyUrl: string,
  targetUrl: string,
  timeoutMs: number,
): Promise<string> {
  const proxy = new URL(proxyUrl);
  const target = new URL(targetUrl);
  const targetPort = target.port
    ? Number(target.port)
    : target.protocol === "https:"
      ? 443
      : 80;

  const tunnel = await openTunnel(proxy, target.hostname, targetPort, timeoutMs);

  return await new Promise<string>((resolve, reject) => {
    const requestFn = target.protocol === "https:" ? https.request : http.request;
    const request = requestFn(
      {
        method: "GET",
        hostname: target.hostname,
        port: targetPort,
        path: `${target.pathname}${target.search}`,
        agent: false,
        timeout: timeoutMs,
        createConnection: () =>
          target.protocol === "https:"
            ? tls.connect({ socket: tunnel, servername: target.hostname })
            : tunnel,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          response.resume();
          tunnel.destroy();
          reject(new ProxyProviderError(`proxy echo endpoint answered ${status}`));
          return;
        }
        response.setEncoding("utf8");
        let body = "";
        response.on("data", (chunk: string) => {
          body += chunk;
          // A hostile or broken echo endpoint must not be able to stream until
          // the process runs out of memory.
          if (body.length > 64_000) {
            response.destroy();
            tunnel.destroy();
            reject(new ProxyProviderError("proxy echo response is too large"));
          }
        });
        response.on("end", () => {
          tunnel.destroy();
          resolve(body);
        });
        response.on("error", (error: Error) => {
          tunnel.destroy();
          reject(new ProxyProviderError(`proxy echo response failed: ${error.message}`));
        });
      },
    );

    request.on("timeout", () => {
      request.destroy();
      tunnel.destroy();
      reject(new ProxyProviderError("proxy echo request timed out"));
    });
    request.on("error", (error: Error) => {
      tunnel.destroy();
      reject(new ProxyProviderError(`proxy echo request failed: ${error.message}`));
    });
    request.end();
  });
}

function openTunnel(
  proxy: URL,
  targetHost: string,
  targetPort: number,
  timeoutMs: number,
): Promise<net.Socket> {
  return new Promise<net.Socket>((resolve, reject) => {
    const authority = `${targetHost}:${targetPort}`;
    const headers: string[] = [
      `CONNECT ${authority} HTTP/1.1`,
      `Host: ${authority}`,
      "Proxy-Connection: keep-alive",
    ];
    if (proxy.username) {
      const credentials = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
      headers.push(
        `Proxy-Authorization: Basic ${Buffer.from(credentials).toString("base64")}`,
      );
    }

    const socket =
      proxy.protocol === "https:"
        ? tls.connect({
            host: proxy.hostname,
            port: Number(proxy.port),
            servername: proxy.hostname,
          })
        : net.connect({ host: proxy.hostname, port: Number(proxy.port) });

    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(
        error instanceof ProxyProviderError
          ? error
          : new ProxyProviderError(`proxy CONNECT failed: ${error.message}`),
      );
    };

    socket.setTimeout(timeoutMs, () => fail(new Error("timed out")));
    socket.once("error", fail);

    const onConnect = (): void => {
      socket.write(`${headers.join("\r\n")}\r\n\r\n`);
    };
    socket.once(proxy.protocol === "https:" ? "secureConnect" : "connect", onConnect);

    let preamble = "";
    const onData = (chunk: Buffer): void => {
      preamble += chunk.toString("latin1");
      const end = preamble.indexOf("\r\n\r\n");
      if (end < 0) {
        if (preamble.length > 8_192) fail(new Error("CONNECT response headers too large"));
        return;
      }
      socket.removeListener("data", onData);

      const statusLine = preamble.slice(0, preamble.indexOf("\r\n"));
      const status = Number(statusLine.split(" ")[1]);
      if (status !== 200) {
        fail(new Error(`proxy refused CONNECT with "${statusLine.trim()}"`));
        return;
      }

      settled = true;
      socket.removeListener("error", fail);
      socket.setTimeout(0);
      /**
       * Anything the proxy sent past the blank line already belongs to the
       * tunnelled conversation. Pushing it back is what stops the first bytes of
       * the echo response from being eaten by this handler — a bug that shows up
       * only under packet timings nobody can reproduce on request.
       */
      const remainder = preamble.slice(end + 4);
      if (remainder.length > 0) {
        // Paused first: attaching the `data` listener above put the socket in
        // flowing mode, and unshifting into a flowing stream re-emits
        // immediately — to nobody, because the next consumer has not attached
        // yet. The HTTP client resumes it when its parser attaches.
        socket.pause();
        socket.unshift(Buffer.from(remainder, "latin1"));
      }
      resolve(socket);
    };
    socket.on("data", onData);
  });
}

let cachedProvider: ProxyProvider | undefined;

/**
 * The configured provider, or `undefined` when none is configured.
 *
 * `undefined` is the state in which the proxy-requiring networks do not exist:
 * the config layer refuses to enable them at all (§9.2 rule 2), and the internal
 * proxy endpoint is not mounted.
 */
export function proxyProvider(): ProxyProvider | undefined {
  const config = bridgesConfig().proxy;
  if (!config) return undefined;
  if (!cachedProvider || cachedProvider.id !== config.providerId) {
    cachedProvider = createTemplateProxyProvider(config);
  }
  return cachedProvider;
}

/** Resets the memoised provider. Tests only. */
export function resetProxyProviderForTests(): void {
  cachedProvider = undefined;
}
