/**
 * Command-line Kasa outlet control, used by the Windows desktop shortcuts.
 *
 * Bundled to a standalone `dist/kasa-toggle.mjs` (see rollup.toggle.mjs) so it
 * runs on any Node without TypeScript support and without needing node_modules.
 *
 *   node kasa-toggle.mjs --host 192.168.1.43 --outlet "Outlet 1"     # toggle
 *   node kasa-toggle.mjs --host 192.168.1.43 --outlet "Outlet 2" --on
 *   node kasa-toggle.mjs --host 192.168.1.42                        # single plug
 *   ... --dry-run                                                   # read only
 *   ... --dry-run --json                                            # machine-readable status
 *
 * Target an outlet by name (`--outlet`, matched case-insensitively against the
 * strip's labels) or directly by `--childId`. Omit both for a single switch.
 *
 * After a real (non-dry-run) toggle, also renames the desktop shortcut that
 * triggered it to reflect the *next* action ("Turn Speakers On"/"Turn Speakers Off") and
 * updates its hover-tooltip Description to match ("Speakers is ON - click to
 * turn off.") — see {@link renameShortcutForNextAction} — using the manifest
 * that `make-desktop-shortcuts.ps1` writes to `desktop-shortcuts.json` next to
 * this bundle. Missing/moved shortcuts are skipped; a rename/description
 * failure never fails the toggle itself. (This only keeps the *desktop* icon
 * live — a copy pinned to the Windows taskbar is a separate, frozen snapshot
 * Windows makes at pin time, and nothing here can update that.)
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { apply, getStatus, outletsOf } from "../src/kasa";

const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

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

	const nextAction = on ? "Off" : "On";
	const nextLabel = `Turn ${entry.label} ${nextAction}`;
	const newPath = path.join(path.dirname(entry.lnkPath), `${nextLabel}.lnk`);
	if (newPath === entry.lnkPath) {
		return;
	}
	try {
		renameShellItem(entry.lnkPath, `${nextLabel}.lnk`);
		// Shell.Application's FolderItem.Name re-appends the extension itself, so
		// verify the rename actually landed at the plain single-extension path we
		// expect before trusting it — otherwise updateShortcutDescription below
		// would call CreateShortcut() on a path nothing exists at, which silently
		// *creates* a new blank .lnk there instead of erroring.
		if (!fs.existsSync(newPath)) {
			throw new Error(`renamed shortcut not found at expected path: ${newPath}`);
		}
		entry.lnkPath = newPath;
		fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
	} catch (err) {
		console.error(`Could not rename desktop shortcut for "${entry.label}":`, err instanceof Error ? err.message : err);
		return;
	}

	const description = `${entry.label} is ${on ? "ON" : "OFF"} - click to turn ${nextAction.toLowerCase()}.`;
	try {
		updateShortcutDescription(newPath, description);
	} catch (err) {
		console.error(`Could not update tooltip for "${entry.label}":`, err instanceof Error ? err.message : err);
	}
}

/**
 * Rename a file via the Shell.Application COM object (the same mechanism as
 * an Explorer F2 rename), NOT `fs.renameSync`. A raw filesystem rename isn't
 * tracked by Explorer's desktop-icon-position cache as "the same icon" — the
 * live desktop view just sees the old file vanish and a new one appear, and
 * drops it into the next free grid slot, so every toggle visibly relocates
 * the icon. A Shell-mediated rename keeps the same shell item identity, so
 * Explorer preserves its on-screen position across the rename.
 *
 * `FolderItem.Name` re-appends the file's real extension no matter what you
 * assign, regardless of the "hide extensions for known file types" setting —
 * passing `newName` WITH its `.lnk` extension produces `name.lnk.lnk` on
 * disk. Assign only the base name and let the shell supply the extension.
 */
function renameShellItem(lnkPath: string, newName: string): void {
	const dir = path.dirname(lnkPath);
	const oldName = path.basename(lnkPath);
	const newBaseName = newName.replace(/\.lnk$/i, "");
	const script = `$s = New-Object -ComObject Shell.Application; $f = $s.Namespace(${psQuote(dir)}); $item = $f.ParseName(${psQuote(oldName)}); if (-not $item) { throw "shell item not found: ${oldName.replace(/"/g, '`"')}" }; $item.Name = ${psQuote(newBaseName)}`;
	execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { stdio: "ignore" });
}

/**
 * Set a `.lnk` file's Description (its Properties "Comment" field, shown as
 * the file-manager/desktop hover tooltip). Node has no native way to edit an
 * existing shortcut's binary format, so this shells out to PowerShell's
 * WScript.Shell COM object — the same mechanism `make-desktop-shortcuts.ps1`
 * uses to create shortcuts in the first place. This only edits the .lnk's
 * internal binary contents (not its filename/identity), so unlike a rename
 * it needs no shell-notification care to keep the desktop icon in place.
 */
function updateShortcutDescription(lnkPath: string, description: string): void {
	const script = `$s = New-Object -ComObject WScript.Shell; $sc = $s.CreateShortcut(${psQuote(lnkPath)}); $sc.Description = ${psQuote(description)}; $sc.Save()`;
	execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { stdio: "ignore" });
}
