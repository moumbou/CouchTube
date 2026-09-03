// CouchTube – extension configuration
// -----------------------------------
// The extension has no environment variables, but Chrome tells us how it was installed:
// an extension from the Chrome Web Store gets an `update_url` injected into its manifest,
// one loaded unpacked from a folder (development) does not. That decides the default relay.
// The user can still override the relay in the popup (stored in chrome.storage.local).

const COUCHTUBE_CONFIG = {
  relay: {
    production: 'wss://relay.couchtube.app',      // the public relay (set this to your deployed server)
    development: 'ws://localhost:8787',     // `pnpm dev` on this machine
  },
};

// true when loaded unpacked (chrome://extensions → Load unpacked), false when installed from a store
const COUCHTUBE_IS_DEV = !chrome.runtime.getManifest().update_url;
const COUCHTUBE_DEFAULT_RELAY = COUCHTUBE_IS_DEV ? COUCHTUBE_CONFIG.relay.development : COUCHTUBE_CONFIG.relay.production;
