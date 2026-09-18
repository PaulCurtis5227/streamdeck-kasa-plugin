import streamDeck from "@elgato/streamdeck";

import { KasaSwitch } from "./actions/kasa-switch";

// Trace-level logging records all traffic between Stream Deck and the plugin;
// handy while developing. Dial back to "info" for a release if it's noisy.
streamDeck.logger.setLevel("trace");

// Register the Kasa switch action.
streamDeck.actions.registerAction(new KasaSwitch());

// Finally, connect to the Stream Deck.
streamDeck.connect();
