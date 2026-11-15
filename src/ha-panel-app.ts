// Entry point. Home Assistant loads this file from a fixed URL, so browsers and
// Home Assistant's service worker keep serving a cached copy after an update.
// Before registering anything, check whether the server has a newer build; if
// so, load that under a versioned URL and evict the stale cached copy.

import { defineAll } from "./registry";
import "./app";

declare const __HPA_VERSION__: string;
declare const __HPA_TAG__: string;
const VERSION = __HPA_VERSION__;
const TAG = __HPA_TAG__; // literal "HPA_VERSION=x.y.z" marker in the built file
const RE = /HPA_VERSION=([0-9][0-9A-Za-z.\-]*)/;

async function evict(base: string) {
  try {
    for (const name of await caches.keys()) {
      const c = await caches.open(name);
      for (const req of await c.keys()) if (req.url.split("?")[0] === base) await c.delete(req);
    }
  } catch {
    /* Cache API unavailable */
  }
  try {
    // Refresh the browser's HTTP cache entry for the plain URL too.
    await fetch(base, { cache: "reload" });
  } catch {
    /* offline */
  }
}

async function boot() {
  const here = new URL(import.meta.url);
  const base = here.origin + here.pathname;
  const pinned = here.searchParams.get("hpa");
  if (!pinned) {
    try {
      // A unique query bypasses both the HTTP cache and the service worker.
      const latest = (await (await fetch(`${base}?hpacheck=${Date.now()}`, { cache: "no-store" })).text()).match(RE)?.[1];
      if (latest && latest !== VERSION) {
        console.info(`ha-panel-app: loading ${latest} (cached copy was ${VERSION})`);
        evict(base);
        await import(/* @vite-ignore */ `${base}?hpa=${encodeURIComponent(latest)}`);
        return;
      }
    } catch {
      /* offline or blocked: use this copy */
    }
  }
  if (customElements.get("ha-panel-app")) {
    // An older build (from before this loader) already registered itself. Evict it and reload once.
    const flag = "hpa-reloaded-" + VERSION;
    if (!sessionStorage.getItem(flag)) {
      sessionStorage.setItem(flag, "1");
      await evict(base);
      location.reload();
    }
    return;
  }
  console.info(`ha-panel-app ${VERSION}`, TAG);
  defineAll();
}

boot();
