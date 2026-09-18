/**
 * Command-line Kasa outlet control, used by the Windows desktop shortcuts.
 *
 * Bundled to a standalone `dist/kasa-toggle.mjs` (see rollup.toggle.mjs) so it
 * runs on any Node without TypeScript support and without needing node_modules.
 *
 *   node kasa-toggle.mjs --host 192.168.1.177 --outlet "Speakers"   # toggle
 *   node kasa-toggle.mjs --host 192.168.1.177 --outlet "Alpine" --on
 *   node kasa-toggle.mjs --host 192.168.1.42                        # single plug
 *   ... --dry-run                                                   # read only
 *   ... --dry-run --json                                            # machine-readable status
 *
 * Target an outlet by name (`--outlet`, matched case-insensitively against the
 * strip's labels) or directly by `--childId`. Omit both for a single switch.
 *
 * After a real (non-dry-run) toggle, also renames the desktop shortcut that
 * triggered it to reflect the *next* action ("Speakers On"/"Speakers Off") —
 * see {@link renameShortcutForNextAction} — using the manifest that
 * `make-desktop-shortcuts.ps1` writes to `desktop-shortcuts.json` next to this
 * bundle. Missing/moved shortcuts are skipped; a rename failure never fails
 * the toggle itself.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { apply, getStatus, outletsOf } from "../src/kasa";

const { values } = parseArgs({
	options: {
		host: { type: "string" },
		outlet: { type: "string" },
		childId: { type: "string" },
		on: { type: "boolean" },
		off: { type: "boolean" },
		"dry-run": { type: "boolean" },
		json: { type: "boolean" },
	},
});

const host = values.host?.trim();
if (!host) {
	console.error("Usage: --host <ip> [--outlet <name> | --childId <id>] [--on|--off] [--dry-run]");
	process.exit(2);
}

let childId = values.childId?.trim();
let name = values.outlet ?? childId ?? host;

// Resolve an outlet name to its childId.
if (!childId && values.outlet) {
	const wanted = values.outlet.trim().toLowerCase();
	const outlets = await outletsOf(host);
	const match = outlets.find((o) => o.alias.trim().toLowerCase() === wanted);
	if (!match) {
		const available = outlets.map((o) => `"${o.alias}"`).join(", ") || "(none found)";
		console.error(`Outlet "${values.outlet}" not found on ${host}. Available: ${available}`);
		process.exit(1);
	}
	childId = match.id;
	name = match.alias;
}

const ref = childId ? { host, childId } : { host };
const behavior = values.on ? "on" : values.off ? "off" : "toggle";

try {
	if (values["dry-run"]) {
		const status = await getStatus(ref);
		if (values.json) {
			console.log(JSON.stringify(status));
		} else {
			console.log(`${status.name}: currently ${status.on ? "ON" : "OFF"} [dry-run, unchanged]`);
		}
	} else {
		const on = await apply(ref, behavior);
		if (values.json) {
			console.log(JSON.stringify({ name, on }));
		} else {
			console.log(`${name}: ${on ? "ON" : "OFF"}`);
		}
		renameShortcutForNextAction(host, values.outlet?.trim(), on);
	}
	process.exit(0);
} catch (err) {
	console.error(`Failed to control ${name} on ${host}:`, err instanceof Error ? err.message : err);
	process.exit(1);
}

/**
 * Rename the desktop shortcut for `host`/`outletName` (if one is tracked in
 * `desktop-shortcuts.json`) to name it for the action a click will perform
 * next. Silently does nothing if there's no manifest, no entry for this
 * switch, or the file has since been moved/deleted — a stale or missing
 * shortcut must never fail the toggle that already succeeded.
 */
function renameShortcutForNextAction(host: string, outletName: string | undefined, on: boolean): void {
	const manifestPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "desktop-shortcuts.json");
	let manifest: Record<string, { label: string; lnkPath: string }>;
	try {
		// Strip a leading BOM: PowerShell's `Set-Content -Encoding utf8` (the only
		// UTF-8 option in Windows PowerShell 5.1) always writes one, which
		// JSON.parse otherwise rejects outright.
		const raw = fs.readFileSync(manifestPath, "utf8").replace(/^﻿/, "");
		manifest = JSON.parse(raw);
	} catch {
		return;
	}

	const key = outletName ? `${host}#${outletName.toLowerCase()}` : host;
	const entry = manifest[key];
	if (!entry) {
		return;
	}

	const nextLabel = `${entry.label} ${on ? "Off" : "On"}`;
	const newPath = path.join(path.dirname(entry.lnkPath), `${nextLabel}.lnk`);
	if (newPath === entry.lnkPath) {
		return;
	}
	try {
		fs.renameSync(entry.lnkPath, newPath);
		entry.lnkPath = newPath;
		fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
	} catch (err) {
		console.error(`Could not rename desktop shortcut for "${entry.label}":`, err instanceof Error ? err.message : err);
	}
}
