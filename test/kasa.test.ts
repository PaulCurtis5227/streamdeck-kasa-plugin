import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { apply, getState, getStatus, outletsOf, setClient, setState, subnetHosts, toggle, watch } from "../src/kasa.ts";

/** Records every call so tests can assert on device I/O. */
class FakePlug {
	power = false;
	alias = "";
	readonly calls: string[] = [];
	readonly opts: { host: string; childId?: string };
	constructor(opts: { host: string; childId?: string }) {
		this.opts = opts;
	}
	/** Multi-outlet strips expose a children map; single plugs leave it undefined. */
	children?: Map<string, { id: string; alias: string; state: number }>;
	async getPowerState(): Promise<boolean> {
		this.calls.push("get");
		return this.power;
	}
	async setPowerState(value: boolean): Promise<true> {
		this.calls.push(`set:${value}`);
		this.power = value;
		return true;
	}
	async togglePowerState(): Promise<boolean> {
		this.power = !this.power;
		this.calls.push("toggle");
		return this.power;
	}
}

/** Minimal stand-in for tplink's Client; hands out (and caches) FakePlugs. */
class FakeClient {
	readonly getDeviceCalls: Array<{ host: string; childId?: string }> = [];
	readonly plugs = new Map<string, FakePlug>();
	/** When true, a childId lookup that wasn't seeded throws, like a real stale childId. */
	failUnknownChildren = false;
	/** Pre-seed a plug (with an optional initial power state) for read tests. */
	seed(host: string, power = false, childId?: string, alias = ""): FakePlug {
		const key = childId ? `${host}#${childId}` : host;
		const plug = new FakePlug({ host, childId });
		plug.power = power;
		plug.alias = alias;
		this.plugs.set(key, plug);
		return plug;
	}
	// Mirrors tplink's async getDevice: fetches sysInfo then returns a handle.
	async getDevice(opts: { host: string; childId?: string }): Promise<FakePlug> {
		this.getDeviceCalls.push(opts);
		const key = opts.childId ? `${opts.host}#${opts.childId}` : opts.host;
		let plug = this.plugs.get(key);
		if (!plug) {
			if (opts.childId && this.failUnknownChildren) {
				throw new Error(`Could not find child with childId ${opts.childId}`);
			}
			plug = new FakePlug(opts);
			this.plugs.set(key, plug);
		}
		return plug;
	}
}

let client: FakeClient;

beforeEach(() => {
	client = new FakeClient();
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- injecting a structural fake
	setClient(client as any);
});

test("getState reflects the device's power state", async () => {
	client.seed("1.2.3.4", true);
	assert.equal(await getState({ host: "1.2.3.4" }), true);
});

test("getStatus returns live power state and the device/outlet name", async () => {
	client.seed("1.2.3.4", true, undefined, "Desk Lamp");
	assert.deepEqual(await getStatus({ host: "1.2.3.4" }), { on: true, name: "Desk Lamp" });
});

test("a stale childId falls back to the whole device instead of throwing", async () => {
	// Single switch that has no outlets; a leftover strip childId must not break it.
	client.failUnknownChildren = true;
	client.seed("192.168.1.176", false, undefined, "fan");
	assert.deepEqual(await getStatus({ host: "192.168.1.176", childId: "STALE_FROM_A_STRIP" }), {
		on: false,
		name: "fan",
	});
});

test("setState forces the requested power state", async () => {
	await setState({ host: "1.2.3.4" }, true);
	assert.equal(client.plugs.get("1.2.3.4")?.power, true);
	await setState({ host: "1.2.3.4" }, false);
	assert.equal(client.plugs.get("1.2.3.4")?.power, false);
});

test("toggle flips state and returns the new value", async () => {
	assert.equal(await toggle({ host: "1.2.3.4" }), true);
	assert.equal(await toggle({ host: "1.2.3.4" }), false);
});

test("apply maps behaviors to the right device call and result", async () => {
	assert.equal(await apply({ host: "h" }, "on"), true);
	assert.equal(await apply({ host: "h" }, "off"), false);
	// after forcing off, a toggle should come back on
	assert.equal(await apply({ host: "h" }, "toggle"), true);
	assert.deepEqual(client.plugs.get("h")?.calls, ["set:true", "set:false", "toggle"]);
});

test("childId is threaded through to the outlet", async () => {
	await setState({ host: "strip", childId: "01" }, true);
	assert.ok(client.plugs.has("strip#01"));
	assert.equal(client.getDeviceCalls.at(-1)?.childId, "01");
});

test("plug handles are cached per outlet (one getPlug per host)", async () => {
	await getState({ host: "5.5.5.5" });
	await setState({ host: "5.5.5.5" }, true);
	await toggle({ host: "5.5.5.5" });
	assert.equal(client.getDeviceCalls.length, 1);
});

test("watch notifies listeners only when the outlet's power state actually changes", async (t) => {
	// @types/node models the newer `enable({apis:[...]})` shape; this project's
	// installed Node 20.10 runtime only accepts the older plain-array form.
	(t.mock.timers.enable as unknown as (apis: string[]) => void)(["setInterval"]);
	const flush = () => Promise.resolve().then(() => Promise.resolve());

	client.seed("1.2.3.4", false, undefined, "Fan");
	const calls: unknown[] = [];
	const unwatch = watch({ host: "1.2.3.4" }, (status) => calls.push(status), 1000);

	t.mock.timers.tick(1000); // first poll always "changes" from the unknown initial state
	await flush();
	assert.deepEqual(calls, [{ on: false, name: "Fan" }]);

	t.mock.timers.tick(1000); // still off: no new notification
	await flush();
	assert.equal(calls.length, 1);

	client.plugs.get("1.2.3.4")!.power = true; // simulate a toggle from elsewhere (desktop shortcut, Kasa app, ...)
	t.mock.timers.tick(1000);
	await flush();
	assert.deepEqual(calls.at(-1), { on: true, name: "Fan" });

	unwatch();
});

test("watch shares one poll across multiple listeners on the same outlet, and stops polling once all unwatch", async (t) => {
	(t.mock.timers.enable as unknown as (apis: string[]) => void)(["setInterval"]);
	const flush = () => Promise.resolve().then(() => Promise.resolve());

	const plug = client.seed("5.5.5.6", false, undefined, "Strip Outlet");
	const a: unknown[] = [];
	const b: unknown[] = [];
	const unwatchA = watch({ host: "5.5.5.6" }, (status) => a.push(status), 1000);
	const unwatchB = watch({ host: "5.5.5.6" }, (status) => b.push(status), 1000);

	plug.power = true;
	t.mock.timers.tick(1000);
	await flush();
	assert.equal(a.length, 1);
	assert.equal(b.length, 1);
	assert.equal(plug.calls.filter((c) => c === "get").length, 1); // one shared poll, not one per listener

	unwatchA();
	unwatchB();
	plug.power = false;
	t.mock.timers.tick(1000);
	await flush();
	assert.equal(a.length, 1); // no more notifications once unwatched
	assert.equal(b.length, 1);
});

test("outletsOf returns a strip's outlets, and [] for a single plug", async () => {
	const single = client.seed("plug");
	assert.deepEqual(await outletsOf("plug"), []);
	assert.equal(single.calls.length, 0); // getPowerState not involved

	const strip = client.seed("strip");
	strip.children = new Map([
		["ID00", { id: "ID00", alias: "Speakers", state: 0 }],
		["ID01", { id: "ID01", alias: "Tivo", state: 1 }],
	]);
	assert.deepEqual(await outletsOf("strip"), [
		{ id: "ID00", alias: "Speakers" },
		{ id: "ID01", alias: "Tivo" },
	]);
});

test("subnetHosts enumerates a /24, excluding network/broadcast/self", () => {
	const hosts = subnetHosts("192.168.1.166", "255.255.255.0");
	assert.equal(hosts.length, 253); // 254 usable minus self (.166)
	assert.equal(hosts[0], "192.168.1.1");
	assert.equal(hosts.at(-1), "192.168.1.254");
	assert.ok(!hosts.includes("192.168.1.0")); // network
	assert.ok(!hosts.includes("192.168.1.255")); // broadcast
	assert.ok(!hosts.includes("192.168.1.166")); // self
});

test("subnetHosts refuses subnets larger than the cap", () => {
	assert.deepEqual(subnetHosts("10.0.0.5", "255.255.0.0"), []); // /16: 65534 usable > cap → skip
	assert.equal(subnetHosts("10.0.0.5", "255.255.252.0").length, 1021); // /22: 1022 usable minus self, under cap
});
