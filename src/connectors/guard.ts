import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

type Env = Record<string, string | undefined>;

export const STDIO_DISABLED_MESSAGE =
  "Local command (stdio) connectors are turned off on the hosted app. Use an http MCP URL instead.";

export const SECRET_REF_DISABLED_MESSAGE =
  "Server secret references are turned off on the hosted app. Paste an API key instead.";

export const PRIVATE_TARGET_MESSAGE =
  "That address points at a private or internal network, which the hosted app cannot reach.";

/**
 * True on a hosted deploy. Pasted stdio commands, server secret references,
 * and private network targets are only allowed outside it (local dev, tests).
 */
export function isHostedRuntime(env: Env = process.env): boolean {
  return env.NODE_ENV === "production" || Boolean(env.VERCEL) || Boolean(env.VERCEL_ENV);
}

/**
 * ?preview= on /connectors/add renders fixture connectors (a fake "connected"
 * Notion and friends) for design review. Fixtures never reach a hosted deploy.
 */
export function fixturePreview(value: string | undefined, env: Env = process.env) {
  return isHostedRuntime(env) ? undefined : value;
}

export class BlockedTargetError extends Error {
  constructor(message = PRIVATE_TARGET_MESSAGE) {
    super(message);
    this.name = "BlockedTargetError";
  }
}

const blocked = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blocked.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  blocked.addSubnet(network, prefix, "ipv6");
}

/** IPv4 dotted form of an IPv4-mapped IPv6 address (::ffff:a.b.c.d or ::ffff:7f00:1). */
function mappedIpv4(address: string): string | null {
  const lower = address.toLowerCase();
  const dotted = /^(?:0{0,4}:){0,5}:?ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (dotted && isIP(dotted[1]!) === 4) return dotted[1]!;
  const hex = /^(?:0{0,4}:){0,5}:?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (!hex) return null;
  const high = parseInt(hex[1]!, 16);
  const low = parseInt(hex[2]!, 16);
  return [high >> 8, high & 255, low >> 8, low & 255].join(".");
}

export function isBlockedAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const family = isIP(bare);
  if (family === 4) return blocked.check(bare, "ipv4");
  if (family !== 6) return true;
  const mapped = mappedIpv4(bare);
  if (mapped) return blocked.check(mapped, "ipv4");
  return blocked.check(bare, "ipv6");
}

/**
 * On a hosted deploy, refuses a URL whose host is or resolves to a loopback,
 * private, link-local, or cloud metadata address. Dev and tests skip the check
 * so local mock MCP servers keep working.
 */
export async function assertPublicTarget(target: string | URL, env: Env = process.env) {
  if (!isHostedRuntime(env)) return;
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw new BlockedTargetError("Target must be an http or https URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BlockedTargetError("Target must be an http or https URL.");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host) throw new BlockedTargetError();
  if (isIP(host)) {
    if (isBlockedAddress(host)) throw new BlockedTargetError();
    return;
  }
  let addresses: { address: string }[];
  try {
    addresses = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new BlockedTargetError(`Couldn't resolve ${host}.`);
  }
  if (addresses.length === 0 || addresses.some((entry) => isBlockedAddress(entry.address))) {
    throw new BlockedTargetError();
  }
}

const MAX_REDIRECTS = 5;

/**
 * fetch that checks every hop with assertPublicTarget, including redirects,
 * which it follows by hand. The DNS answer can still change between the check
 * and the connection; this narrows SSRF, it does not pin addresses.
 */
export function guardedFetch(env: Env = process.env): typeof fetch {
  return async (input, init) => {
    if (!isHostedRuntime(env)) return fetch(input, init);
    if (input instanceof Request) {
      await assertPublicTarget(input.url, env);
      return fetch(new Request(input, { ...init, redirect: "error" }));
    }
    let url = String(input);
    let request: RequestInit | undefined = init;
    const follow = (request?.redirect ?? "follow") === "follow";
    for (let hop = 0; ; hop += 1) {
      await assertPublicTarget(url, env);
      const response = await fetch(url, { ...request, redirect: "manual" });
      const location = response.headers.get("location");
      if (!follow || response.status < 300 || response.status >= 400 || !location) {
        return response;
      }
      if (hop >= MAX_REDIRECTS) throw new BlockedTargetError("Too many redirects.");
      url = new URL(location, url).toString();
      if (response.status === 303) request = { ...request, method: "GET", body: undefined };
    }
  };
}
