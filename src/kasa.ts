import os from "node:os";

import tplink from "tplink-smarthome-api";
import type * as TPLink from "tplink-smarthome-api";

// `tplink-smarthome-api` is CommonJS. A default import yields its full
// `module.exports` in both Node's native ESM loader (tests) and the rollup
// bundle, whereas named ESM imports aren't detected by Node when loading the
// raw CJS. Types come from a type-only namespace import (erased at runtime).
const { Client, Plug } = tplink;

/**
 * Thin wrapper around `tplink-smarthome-api` that isolates all device I/O so the
 * action code stays trivial and this layer can be unit-tested with a fake Client.
 *
 * Kasa switches (HS200) and plugs (HS100/HS103/HS105/HS110) are all the "Plug"
 * device type, so a single {@link Plug} code path covers them. Multi-outlet
 * strips (HS107/HS300) expose each outlet via a `childId`.
 */

/** Milliseconds to wait for a device to respond before giving up. */
const DEFAULT_TIMEOUT = 5000;

/** Identifies a single controllable outlet: a host, plus a childId for strips. */
export type OutletRef = {
	host: string;
	childId?: string;
};

/** How a key press affects the outlet. */
export type Behavior = "toggle" | "on" | "off";

/** A plug (or a single outlet of a strip) found on the LAN during discovery. */
export type DiscoveredOutlet = {
	host: string;
	childId?: string;
	alias: string;
	/** Present for multi-outlet strips: each outlet's Outlet ID and label. */
	children?: Array<{ id: string; alias: string }>;
};

// One shared Client for the whole plugin; device handles are cached per outlet.
let sharedClient: TPLink.Client | undefined;
const plugCache = new Map<string, TPLink.AnyDevice>();

/** Lazily create (once) and return the shared {@link Client}. */
export function getClient(): TPLink.Client {
	// `logLevel: "silent"` suppresses the library's per-probe TCP error logging,
	// which would otherwise flood the plugin log with a stack trace for every
	// non-Kasa host during a discovery sweep.
	return (sharedClient ??= new Client({ logLevel: "silent" }));
}

/**
 * Override the shared client. Intended for tests, which inject a fake Client
 * that returns stub Plugs without touching the network.
 */
export function setClient(client: TPLink.Client | undefined): void {
	sharedClient = client;
	plugCache.clear();
	for (const entry of watchers.values()) {
		clearInterval(entry.timer);
	}
	watchers.clear();
}

function cacheKey(ref: OutletRef): string {
	return ref.childId ? `${ref.host}#${ref.childId}` : ref.host;
}

/**
 * Resolve (and cache) a device handle for an outlet. Uses the async
 * `getDevice`, which fetches the device's sysInfo over the network and builds
 * the correct handle — unlike the synchronous `getPlug`, which REQUIRES caller-
 * supplied sysInfo and throws without it. `childId` is threaded through so a
 * single outlet of a multi-outlet strip can be targeted.
 */
async function getPlug(ref: OutletRef, timeout = DEFAULT_TIMEOUT): Promise<TPLink.AnyDevice> {
	const key = cacheKey(ref);
	const cached = plugCache.get(key);
	if (cached) {
		return cached;
	}
	// Try the childId-scoped lookup first, then fall back to the whole device.
	// The fallback matters when a childId is stale — e.g. the user picked a strip
	// outlet, then switched the host to a single switch that has no such child;
	// without it, `getDevice` throws "Could not find child" and the key can't
	// render. Each option is retried once because strips occasionally return a
	// partial sysinfo (missing `children`) on the first request.
	const options = ref.childId
		? [{ host: ref.host, childId: ref.childId }, { host: ref.host }]
		: [{ host: ref.host }];
	let lastError: unknown;
	for (const option of options) {
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				const device = await getClient().getDevice(option, { timeout, transport: "tcp" });
				plugCache.set(key, device);
				return device;
			} catch (err) {
				lastError = err;
			}
		}
	}
	throw lastError;
}

/** Current on/off state and display name (device alias, or outlet alias for strips). */
export type OutletStatus = { on: boolean; name: string };

/** Read an outlet's power state and name in one call. */
export async function getStatus(ref: OutletRef, timeout = DEFAULT_TIMEOUT): Promise<OutletStatus> {
	const device = await getPlug(ref, timeout);
	const on = await device.getPowerState({ timeout });
	return { on, name: device.alias };
}

/** The display name (alias) of an outlet, from the cached handle (no extra I/O once resolved). */
export async function nameOf(ref: OutletRef, timeout = DEFAULT_TIMEOUT): Promise<string> {
	return (await getPlug(ref, timeout)).alias;
}

/** Read the current power state of an outlet. `true` = on. */
export async function getState(ref: OutletRef, timeout = DEFAULT_TIMEOUT): Promise<boolean> {
	return (await getStatus(ref, timeout)).on;
}

/** Force an outlet on or off. */
export async function setState(ref: OutletRef, on: boolean, timeout = DEFAULT_TIMEOUT): Promise<void> {
	await (await getPlug(ref, timeout)).setPowerState(on, { timeout });
}

/** Flip an outlet's state; resolves to the new state. */
export async function toggle(ref: OutletRef, timeout = DEFAULT_TIMEOUT): Promise<boolean> {
	return (await getPlug(ref, timeout)).togglePowerState({ timeout });
}

/**
 * Apply a {@link Behavior} to an outlet and resolve to the resulting power
 * state, so the caller can update the key without a second round-trip.
 */
export async function apply(ref: OutletRef, behavior: Behavior, timeout = DEFAULT_TIMEOUT): Promise<boolean> {
	switch (behavior) {
		case "on":
			await setState(ref, true, timeout);
			return true;
		case "off":
			await setState(ref, false, timeout);
			return false;
		case "toggle":
		default:
			return toggle(ref, timeout);
	}
}

/** How often {@link watch} re-polls a device to notice state changes made elsewhere. */
const WATCH_POLL_MS = 5000;

type WatchListener = (status: OutletStatus) => void;
type WatchEntry = { listeners: Set<WatchListener>; timer: ReturnType<typeof setInterval>; lastOn?: boolean };
const watchers = new Map<string, WatchEntry>();

/**
 * Poll an outlet and invoke `onChange` whenever its power state differs from
 * the last known value. This is what keeps a Stream Deck key in sync when the
 * outlet is switched from elsewhere — a desktop shortcut, the Kasa app, or a
 * physical button — rather than only refreshing on `willAppear`. Multiple
 * watchers on the same outlet (e.g. two keys pointing at the same strip
 * outlet) share a single underlying poll. Returns an unwatch function.
 */
export function watch(ref: OutletRef, onChange: WatchListener, intervalMs = WATCH_POLL_MS): () => void {
	const key = cacheKey(ref);
	let entry = watchers.get(key);
	if (!entry) {
		const created: WatchEntry = { listeners: new Set(), timer: undefined as unknown as ReturnType<typeof setInterval> };
		created.timer = setInterval(() => {
			getStatus(ref).then(
				(status) => {
					if (status.on !== created.lastOn) {
						created.lastOn = status.on;
						for (const listener of created.listeners) {
							listener(status);
						}
					}
				},
				() => {
					// Transient read failure (device briefly offline, etc.); try again next tick.
				},
			);
		}, intervalMs);
		entry = created;
		watchers.set(key, entry);
	}
	entry.listeners.add(onChange);
	return () => {
		entry!.listeners.delete(onChange);
		if (entry!.listeners.size === 0) {
			clearInterval(entry!.timer);
			watchers.delete(key);
		}
	};
}

/**
 * List the outlets of a multi-outlet strip at `host` (empty for a single
 * switch/plug). Reuses the cached whole-device handle, whose children come from
 * the sysInfo fetched by {@link getState}/{@link getPlug}.
 */
export async function outletsOf(host: string, timeout = DEFAULT_TIMEOUT): Promise<Array<{ id: string; alias: string }>> {
	const device = await getPlug({ host }, timeout);
	const children = (device as TPLink.Plug).children;
	if (children && typeof children.values === "function") {
		return [...children.values()].map((c) => ({ id: c.id, alias: c.alias }));
	}
	return [];
}

const ipToInt = (ip: string): number => ip.split(".").reduce((acc, oct) => ((acc << 8) | Number(oct)) >>> 0, 0) >>> 0;
const intToIp = (n: number): string => [24, 16, 8, 0].map((shift) => (n >>> shift) & 255).join(".");

/**
 * Enumerate the usable host IPs in the subnet of `address`/`netmask` (network
 * and broadcast addresses and `address` itself excluded). Returns `[]` when the
 * subnet is larger than `maxHosts` — sweeping a /16 host-by-host is impractical.
 * Exported for unit testing the (error-prone) IP arithmetic.
 */
export function subnetHosts(address: string, netmask: string, maxHosts = 1024): string[] {
	const ip = ipToInt(address);
	const mask = ipToInt(netmask);
	const network = (ip & mask) >>> 0;
	const broadcast = (network | (~mask >>> 0)) >>> 0;
	const usable = broadcast - network - 1;
	if (usable <= 0 || usable > maxHosts) {
		return [];
	}
	const hosts: string[] = [];
	for (let addr = network + 1; addr < broadcast; addr++) {
		if (addr !== ip) {
			hosts.push(intToIp(addr >>> 0));
		}
	}
	return hosts;
}

/** All sweepable host IPs across the machine's external IPv4 interfaces. */
function localSweepHosts(): string[] {
	const hosts = new Set<string>();
	for (const addrs of Object.values(os.networkInterfaces())) {
		for (const addr of addrs ?? []) {
			if (addr.family === "IPv4" && !addr.internal) {
				for (const host of subnetHosts(addr.address, addr.netmask)) {
					hosts.add(host);
				}
			}
		}
	}
	return [...hosts];
}

/** Run `worker` over `items` with at most `size` in flight at once. */
async function pool<T>(items: T[], size: number, worker: (item: T) => Promise<void>): Promise<void> {
	let next = 0;
	const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
		while (next < items.length) {
			await worker(items[next++]!);
		}
	});
	await Promise.all(runners);
}

/**
 * Find Kasa plugs/switches on the LAN by a **TCP unicast sweep** of the local
 * subnet(s), resolving to one entry per device (keyed by host).
 *
 * We deliberately avoid UDP broadcast discovery: its replies are unsolicited
 * inbound packets that Windows Firewall drops for a fresh plugin binary, so it
 * silently finds nothing. A TCP probe rides back on the outbound connection the
 * firewall already permits (the same path device control uses), so it works
 * without any firewall prompt. Non-Kasa hosts reject/close fast and are skipped.
 */
export async function discover(perHostTimeout = 1200): Promise<DiscoveredOutlet[]> {
	const client = getClient();
	const found = new Map<string, DiscoveredOutlet>();
	await pool(localSweepHosts(), 64, async (host) => {
		try {
			const device = await client.getDevice({ host }, { timeout: perHostTimeout, transport: "tcp" });
			if (device instanceof Plug) {
				const children = [...device.children.values()].map((c) => ({ id: c.id, alias: c.alias }));
				found.set(host, { host, alias: device.alias || host, ...(children.length ? { children } : {}) });
			}
		} catch {
			// No Kasa device answered at this host — expected for most of the subnet.
		}
	});
	return [...found.values()];
}
