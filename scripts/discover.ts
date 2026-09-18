/**
 * Standalone LAN scan for Kasa devices — run with `npm run discover`.
 *
 * Prints "<alias>  <ip>" for each switch/plug found, so you can copy the IP into
 * the action's Device IP field. Uses the same TCP sweep as the plugin's in-app
 * discovery, so it works even when UDP broadcast discovery is firewall-blocked.
 */
import { discover } from "../src/kasa.ts";

const devices = await discover();

if (devices.length === 0) {
	console.log("No Kasa devices found on your LAN.");
	console.log("Check that this PC and the switch are on the same subnet (no guest/IoT VLAN or AP isolation).");
} else {
	console.log(`Found ${devices.length} Kasa device(s):\n`);
	for (const d of devices.sort((a, b) => a.alias.localeCompare(b.alias))) {
		console.log(`  ${d.alias.padEnd(28)} ${d.host}`);
		// Multi-outlet strips: list each outlet's Outlet ID (paste into the action).
		for (const child of d.children ?? []) {
			console.log(`      └ outlet "${child.alias}"  →  Outlet ID: ${child.id}`);
		}
	}
}

process.exit(0);
