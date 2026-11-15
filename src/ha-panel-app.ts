// Entry point. Home Assistant loads this file from a fixed URL, so browsers
// (and the tablet's web view) tend to keep serving a cached copy after an
// update. Before registering anything, check whether the file on the server is
// newer than this copy; if it is, load the new one under a versioned URL.

declare const __HPA_VERSION__: string;
declare const __HPA_TAG__: string;
const VERSION = __HPA_VERSION__;
const TAG = __HPA_TAG__; // literal "HPA_VERSION=x.y.z" marker in the built file
const RE = /HPA_VERSION=([0-9][0-9A-Za-z.\-]*)/;

async function boot() {
  const here = new URL(import.meta.url);
  const pinned = here.searchParams.get("hpa");
  if (!pinned) {
    try {
      const base = here.origin + here.pathname;
      const latest = (await (await fetch(base, { cache: "no-cache" })).text()).match(RE)?.[1];
      if (latest && latest !== VERSION) {
        console.info(`ha-panel-app: loading ${latest} (cached copy was ${VERSION})`);
        await import(/* @vite-ignore */ `${base}?hpa=${encodeURIComponent(latest)}`);
        return;
      }
    } catch {
      /* offline or blocked: use this copy */
    }
  }
  console.info(`ha-panel-app ${VERSION}`, TAG);
  await import("./app");
}

boot();
