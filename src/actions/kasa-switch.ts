import {
	action,
	type DidReceiveSettingsEvent,
	type KeyAction,
	type KeyDownEvent,
	type SendToPluginEvent,
	SingletonAction,
	streamDeck,
	type WillAppearEvent,
	type WillDisappearEvent,
} from "@elgato/streamdeck";
import type { JsonValue } from "@elgato/utils";

import { apply, type Behavior, discover, getStatus, nameOf, type OutletStatus, outletsOf, type OutletRef, watch } from "../kasa";

/** Settings persisted per key by Stream Deck / the property inspector. */
type KasaSettings = {
	/** Device IP or hostname on the LAN, e.g. "10.0.1.23". */
	host?: string;
	/** Outlet id for multi-outlet strips (HS107/HS300); blank for single switches. */
	childId?: string;
	/** What a press does. Defaults to "toggle". */
	behavior?: Behavior;
};

/** Data-source event names shared with the property inspector's dropdowns. */
const DISCOVER_EVENT = "getDevices";
const OUTLETS_EVENT = "getOutlets";

/** Runtime images for the two on/off looks (green / gray). */
const IMAGE_ON = "imgs/actions/switch/on.png";
const IMAGE_OFF = "imgs/actions/switch/off.png";

/**
 * Turns a TP-Link Kasa switch or plug on/off from a Stream Deck key. The key is
 * a single state that the plugin draws itself — title = the switch/outlet name,
 * image + ON/OFF text = the live device reading — so what's shown always matches
 * reality. (A two-state key can't: Stream Deck auto-advances the state on press,
 * which drifts out of sync with the real device.)
 */
@action({ UUID: "com.caffecter.kasa.switch" })
export class KasaSwitch extends SingletonAction<KasaSettings> {
	/** Live-state unwatch functions, keyed by action instance id (see {@link watch}). */
	private readonly unwatchers = new Map<string, () => void>();

	/**
	 * Reflect the device's current state when the key becomes visible (startup,
	 * page/folder navigation, or after editing settings), and start watching it
	 * so the key also updates if the device is switched elsewhere.
	 */
	override async onWillAppear(ev: WillAppearEvent<KasaSettings>): Promise<void> {
		await this.refresh(ev);
		if (ev.action.isKey()) {
			this.startWatching(ev.action, ev.payload.settings);
		}
	}

	/** Stop polling a key's device once it's no longer visible. */
	override onWillDisappear(ev: WillDisappearEvent<KasaSettings>): void {
		this.stopWatching(ev.action);
	}

	/**
	 * Re-query after the user changes the IP/outlet/behavior in the inspector,
	 * and refresh the outlet dropdown to match the (possibly new) device — this
	 * is what makes Outlet ID a dependent pull-down: picking a host here pushes
	 * that device's outlets to the property inspector.
	 */
	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<KasaSettings>): Promise<void> {
		// If the childId is stale for the current host (e.g. switched from a strip
		// outlet to a single switch), clear it. That triggers a fresh settings
		// event which redraws with the corrected ref, so return early here.
		if (await this.clearStaleChildId(ev.action, ev.payload.settings)) {
			return;
		}
		await this.refresh(ev);
		await this.pushOutlets(ev.payload.settings);
		if (ev.action.isKey()) {
			this.startWatching(ev.action, ev.payload.settings);
		}
	}

	/**
	 * Apply the configured behavior on press, then redraw with the new state.
	 */
	override async onKeyDown(ev: KeyDownEvent<KasaSettings>): Promise<void> {
		if (!ev.action.isKey()) {
			return;
		}

		const ref = this.outletRef(ev.payload.settings);
		if (!ref) {
			await ev.action.showAlert(); // no device configured yet
			return;
		}

		const behavior = ev.payload.settings.behavior ?? "toggle";
		try {
			const on = await apply(ref, behavior);
			await this.render(ev.action, { on, name: await nameOf(ref) });
		} catch (err) {
			streamDeck.logger.error("Failed to control Kasa device", err);
			await ev.action.showAlert();
		}
	}

	/**
	 * Respond to the property inspector's "discover devices" request by scanning
	 * the LAN and returning a list the inspector's dropdown can render.
	 */
	override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, KasaSettings>): Promise<void> {
		const event = typeof ev.payload === "object" && ev.payload !== null ? (ev.payload as { event?: string }).event : undefined;

		if (event === DISCOVER_EVENT) {
			try {
				const outlets = await discover();
				const items = outlets
					.sort((a, b) => a.alias.localeCompare(b.alias))
					.map((o) => ({ label: `${o.alias} (${o.host})`, value: o.host }));
				await streamDeck.ui.sendToPropertyInspector({ event: DISCOVER_EVENT, items });
			} catch (err) {
				streamDeck.logger.error("Kasa discovery failed", err);
				await streamDeck.ui.sendToPropertyInspector({ event: DISCOVER_EVENT, items: [] });
			}
		} else if (event === OUTLETS_EVENT) {
			// The outlet dropdown's initial load asks for its items; reply for the
			// currently-configured host.
			await this.pushOutlets(await ev.action.getSettings());
		}
	}

	/**
	 * Push the outlets of the configured host to the outlet dropdown in the
	 * property inspector (empty list for single switches or no host). Called both
	 * for the dropdown's initial request and whenever settings change, which is
	 * what keeps the pull-down in sync with the selected switch.
	 */
	private async pushOutlets(settings: KasaSettings): Promise<void> {
		const host = settings.host?.trim();
		let items: Array<{ label: string; value: string }> = [];
		if (host) {
			try {
				const outlets = await outletsOf(host);
				items = outlets.map((o) => ({ label: o.alias, value: o.id }));
			} catch (err) {
				streamDeck.logger.error("Failed to list Kasa outlets", err);
			}
		}
		await streamDeck.ui.sendToPropertyInspector({ event: OUTLETS_EVENT, items });
	}

	/**
	 * Drop a `childId` that doesn't belong to the configured host (single switch,
	 * or a different strip). Returns `true` if it changed settings — the caller
	 * should then wait for the resulting settings event rather than redraw now.
	 */
	private async clearStaleChildId(action: SendToPluginEvent<JsonValue, KasaSettings>["action"], settings: KasaSettings): Promise<boolean> {
		const host = settings.host?.trim();
		const childId = settings.childId?.trim();
		if (!host || !childId) {
			return false;
		}
		try {
			const outlets = await outletsOf(host);
			if (outlets.some((o) => o.id === childId)) {
				return false; // still valid
			}
		} catch (err) {
			streamDeck.logger.error("Could not verify Kasa outlet; leaving settings as-is", err);
			return false; // don't discard the user's setting on a transient read failure
		}
		const { childId: _drop, ...rest } = settings;
		await action.setSettings(rest);
		return true;
	}

	/**
	 * (Re)start watching the outlet configured in `settings` for external state
	 * changes, replacing any watch already running for this action instance.
	 */
	private startWatching(action: KeyAction<KasaSettings>, settings: KasaSettings): void {
		this.stopWatching(action);
		const ref = this.outletRef(settings);
		if (!ref) {
			return;
		}
		this.unwatchers.set(
			action.id,
			watch(ref, (status) => {
				void this.render(action, status);
			}),
		);
	}

	/** Stop watching (if watching) this action instance's outlet. */
	private stopWatching(action: { id: string }): void {
		this.unwatchers.get(action.id)?.();
		this.unwatchers.delete(action.id);
	}

	/** Build an {@link OutletRef} from settings, or `undefined` if no host set. */
	private outletRef(settings: KasaSettings): OutletRef | undefined {
		const host = settings.host?.trim();
		if (!host) {
			return undefined;
		}
		const childId = settings.childId?.trim();
		return childId ? { host, childId } : { host };
	}

	/** Query the device and redraw the key to match (or alert on error). */
	private async refresh(ev: WillAppearEvent<KasaSettings> | DidReceiveSettingsEvent<KasaSettings>): Promise<void> {
		if (!ev.action.isKey()) {
			return;
		}

		const ref = this.outletRef(ev.payload.settings);
		if (!ref) {
			await ev.action.setImage(IMAGE_OFF);
			await ev.action.setTitle("Set device\nin settings");
			return;
		}

		try {
			await this.render(ev.action, await getStatus(ref));
		} catch (err) {
			streamDeck.logger.error("Failed to read Kasa device state", err);
			await ev.action.showAlert();
		}
	}

	/** Draw the key: title = switch/outlet name, image + ON/OFF text = live state. */
	private async render(action: KeyAction<KasaSettings>, status: OutletStatus): Promise<void> {
		await action.setImage(status.on ? IMAGE_ON : IMAGE_OFF);
		await action.setTitle(`${status.name}\n${status.on ? "ON" : "OFF"}`);
	}
}
