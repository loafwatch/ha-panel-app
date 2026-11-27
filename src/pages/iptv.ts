import { reg } from "../registry";
import { css, html, nothing } from "lit";
import { state } from "lit/decorators.js";
import Hls from "hls.js/dist/hls.light.mjs";
import mpegts from "mpegts.js";
import { PageBase } from "./base";
import { keepAwake } from "../util";

interface Channel {
  name: string;
  url: string;
  logo?: string;
  groups: string[];
}

const FAV_KEY = "hpa-iptv-favs";

/**
 * Live TV from an M3U playlist (for example a free-to-air list from the
 * open-source iptv-org project). Channel tiles with groups, search and
 * favourites; tapping a channel plays it full screen with HLS.
 */
export class PageIptv extends PageBase {
  @state() private channels: Channel[] = [];
  @state() private loadState: "idle" | "loading" | "ok" | "error" = "idle";
  @state() private q = "";
  @state() private group = "";
  @state() private playing?: Channel;
  @state() private status = "";
  /** Player controls (close, channel, volume) show on a tap and fade after a few seconds. */
  @state() private ctrls = true;
  private ctrlTimer?: number;

  /** Tap the picture to show the controls, tap it again to hide them; using a control keeps them up. */
  private tapPlayer = (e: PointerEvent) => {
    const onCtl = e.composedPath().some((n) => n instanceof HTMLElement && (n.classList.contains("ptop") || n.classList.contains("pbot")));
    if (onCtl || !this.ctrls) this.poke();
    else {
      window.clearTimeout(this.ctrlTimer);
      this.ctrls = false;
    }
  };

  private poke = () => {
    this.ctrls = true;
    window.clearTimeout(this.ctrlTimer);
    this.ctrlTimer = window.setTimeout(() => (this.ctrls = false), 3500);
  };
  @state() private favs: string[] = (() => {
    try {
      return JSON.parse(localStorage.getItem(FAV_KEY) || "[]");
    } catch {
      return [];
    }
  })();
  private hls?: Hls;
  private ts?: any;
  private loadedAt = 0;

  protected watched() {
    return [];
  }

  protected updated(changed: Map<string, unknown>) {
    super.updated?.(changed as any);
    if (this.active && (this.loadState === "idle" || Date.now() - this.loadedAt > 6 * 3600 * 1000)) this.load();
    if (!this.active && this.playing) this.stop();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.stop();
  }

  private async load() {
    const url = this.config.iptv?.playlist;
    if (!url) return;
    this.loadState = this.channels.length ? "ok" : "loading";
    this.loadedAt = Date.now();
    try {
      const text = await (await fetch(url)).text();
      this.channels = parseM3u(text);
      this.loadState = "ok";
    } catch {
      this.loadState = "error";
    }
  }

  private saveFavs() {
    try {
      localStorage.setItem(FAV_KEY, JSON.stringify(this.favs));
    } catch {
      /* storage unavailable: favourites last for this visit only */
    }
  }

  private toggleFav(c: Channel, e: Event) {
    e.stopPropagation();
    this.favs = this.favs.includes(c.url) ? this.favs.filter((u) => u !== c.url) : [...this.favs, c.url];
    this.saveFavs();
  }

  private filtered() {
    const q = this.q.trim().toLowerCase();
    let list = this.channels;
    if (this.group === "★") list = list.filter((c) => this.favs.includes(c.url));
    else if (this.group) list = list.filter((c) => c.groups.includes(this.group));
    if (q) list = list.filter((c) => c.name.toLowerCase().includes(q));
    return list;
  }

  private async play(c: Channel) {
    this.playing = c;
    this.poke();
    keepAwake(this, true);
    this.status = "Loading…";
    await this.updateComplete;
    const v = this.renderRoot.querySelector("video") as HTMLVideoElement | null;
    if (!v) return;
    this.hls?.destroy();
    this.hls = undefined;
    this.ts?.destroy();
    this.ts = undefined;
    const ok = () => (this.status = "");
    const fail = () => (this.status = "This channel isn't available right now. It may be offline or only work in some countries.");
    v.onplaying = ok;
    v.onerror = fail;
    if (Hls.isSupported() && /\.m3u8(\?|$)/i.test(c.url)) {
      const hls = new Hls({ lowLatencyMode: false, maxBufferLength: 30, liveSyncDurationCount: 4 });
      this.hls = hls;
      hls.on(Hls.Events.ERROR, (_e, d) => {
        if (d.fatal) fail();
      });
      hls.loadSource(c.url);
      hls.attachMedia(v);
    } else if (mpegts.getFeatureList().mseLivePlayback) {
      // raw MPEG-TS streams (e.g. relayed by Threadfin)
      const p = mpegts.createPlayer({ type: "mpegts", isLive: true, url: c.url }, {
          // a few seconds of buffer for smooth playback; we stay slightly behind live instead of chasing it
          enableStashBuffer: true,
          stashInitialSize: 1024 * 1024,
          liveBufferLatencyChasing: false,
          lazyLoad: false,
          autoCleanupSourceBuffer: true,
        });
      this.ts = p;
      p.on(mpegts.Events.ERROR, fail);
      p.attachMediaElement(v);
      p.load();
    } else {
      v.src = c.url;
    }
    v.play().catch(() => undefined);
  }

  private step(dir: 1 | -1) {
    const list = this.filtered();
    if (!this.playing || !list.length) return;
    const i = list.findIndex((c) => c.url === this.playing!.url);
    this.play(list[(i + dir + list.length) % list.length]);
  }

  private stop() {
    window.clearTimeout(this.ctrlTimer);
    this.hls?.destroy();
    this.hls = undefined;
    this.ts?.destroy();
    this.ts = undefined;
    const v = this.renderRoot?.querySelector("video") as HTMLVideoElement | null;
    if (v) {
      v.pause();
      v.removeAttribute("src");
      v.load();
    }
    this.playing = undefined;
    this.status = "";
    keepAwake(this, false);
  }

  render() {
    if (!this.config.iptv?.playlist) return html`<div class="page"><div class="empty">No playlist configured.</div></div>`;
    const groups = [...new Set(this.channels.flatMap((c) => c.groups))].filter((g) => g && g !== "Undefined").sort();
    const list = this.filtered();
    return html`
      <div class="page">
        <div class="bar">
          <div class="search">
            <ha-icon icon="mdi:magnify"></ha-icon>
            <input type="search" placeholder="Search channels" .value=${this.q} @input=${(e: InputEvent) => (this.q = (e.target as HTMLInputElement).value)} autocomplete="off" />
            ${this.q ? html`<button class="clr" aria-label="Clear" @click=${() => (this.q = "")}><ha-icon icon="mdi:close"></ha-icon></button>` : nothing}
          </div>
        </div>
        <div class="chips">
          <button class=${this.group === "" ? "on" : ""} @click=${() => (this.group = "")}>All</button>
          <button class=${this.group === "★" ? "on" : ""} @click=${() => (this.group = "★")}><ha-icon icon="mdi:star"></ha-icon>Favourites</button>
          ${groups.map((g) => html`<button class=${this.group === g ? "on" : ""} @click=${() => (this.group = g)}>${g}</button>`)}
        </div>
        ${this.loadState === "error"
          ? html`<div class="empty">Couldn't load the channel list.</div>`
          : this.loadState !== "ok"
            ? html`<div class="empty">Loading channels…</div>`
            : !list.length
              ? html`<div class="empty">${this.group === "★" ? "Tap the star on a channel to add it here." : "No channels match."}</div>`
              : html`<div class="grid">
                  ${list.map(
                    (c) => html`<button class="ch tile" @click=${() => this.play(c)}>
                      <span class="logo">
                        <ha-icon icon="mdi:television-classic"></ha-icon>
                        ${c.logo ? html`<img src=${c.logo} alt="" loading="lazy" referrerpolicy="no-referrer" @error=${(e: Event) => ((e.target as HTMLElement).style.display = "none")} />` : nothing}
                      </span>
                      <span class="nm">${c.name}</span>
                      <span class="fav ${this.favs.includes(c.url) ? "on" : ""}" @click=${(e: Event) => this.toggleFav(c, e)}>
                        <ha-icon icon=${this.favs.includes(c.url) ? "mdi:star" : "mdi:star-outline"}></ha-icon>
                      </span>
                    </button>`,
                  )}
                </div>`}
      </div>
      ${this.playing
        ? html`<div class="player ${this.ctrls ? "" : "quiet"}" @pointerdown=${this.tapPlayer}>
            <video playsinline autoplay></video>
            <div class="ptop">
              <div class="pn">${this.playing.name}</div>
              <button class="pb" aria-label="Close" @click=${() => this.stop()}><ha-icon icon="mdi:close"></ha-icon></button>
            </div>
            ${this.status ? html`<div class="pstatus">${this.status}</div>` : nothing}
            <div class="pbot">
              <button class="pb" aria-label="Previous channel" @click=${() => this.step(-1)}><ha-icon icon="mdi:chevron-left"></ha-icon></button>
              ${this.config.volume ? html`<panel-volume .hass=${this.hass} entity=${this.config.volume}></panel-volume>` : nothing}
              <button class="pb" aria-label="Next channel" @click=${() => this.step(1)}><ha-icon icon="mdi:chevron-right"></ha-icon></button>
            </div>
          </div>`
        : nothing}
    `;
  }

  static styles = [
    PageBase.styles,
    css`
      button {
        font: inherit;
        color: inherit;
        border: 0;
        background: none;
        cursor: pointer;
        -webkit-tap-highlight-color: transparent;
      }
      .bar {
        margin-bottom: 12px;
      }
      .search {
        display: flex;
        align-items: center;
        gap: 10px;
        height: 52px;
        padding: 0 8px 0 16px;
        border-radius: 999px;
        background: var(--tile);
        box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--accent) 35%, transparent);
      }
      .search input {
        flex: 1;
        min-width: 0;
        border: 0;
        outline: 0;
        background: transparent;
        color: var(--text);
        font: 500 17px var(--font);
      }
      .search input::-webkit-search-cancel-button {
        display: none;
      }
      .search ha-icon {
        color: var(--text-2);
      }
      .clr {
        display: grid;
        place-items: center;
        width: 40px;
        height: 40px;
        border-radius: 50%;
      }
      .chips {
        display: flex;
        gap: 8px;
        overflow-x: auto;
        scrollbar-width: none;
        margin-bottom: 16px;
      }
      .chips button {
        flex: none;
        display: inline-flex;
        align-items: center;
        gap: 5px;
        padding: 8px 16px;
        border-radius: 999px;
        background: var(--tile);
        font-weight: 600;
        font-size: 14px;
        box-shadow: inset 0 0 0 1px rgba(127, 127, 127, 0.2);
        --mdc-icon-size: 16px;
      }
      .chips button.on {
        background: var(--grad);
        color: #fff;
        box-shadow: none;
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
        gap: 12px;
      }
      .ch {
        position: relative;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 8px;
        padding: 14px 10px 12px;
        text-align: center;
        transition: transform 0.1s;
      }
      .ch:active {
        transform: scale(0.96);
      }
      .logo {
        position: relative;
        display: grid;
        place-items: center;
        width: 100%;
        height: 64px;
        color: var(--text-2);
        --mdc-icon-size: 34px;
      }
      .logo img {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        object-fit: contain;
        background: var(--tile);
      }
      .nm {
        font-size: 13px;
        font-weight: 600;
        line-height: 1.25;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      .fav {
        position: absolute;
        top: 6px;
        right: 6px;
        color: var(--text-2);
        --mdc-icon-size: 20px;
      }
      .fav.on {
        color: #ffc83d;
      }
      .player {
        position: absolute;
        inset: 0;
        z-index: 20;
        background: #000;
      }
      .player video {
        width: 100%;
        height: 100%;
        object-fit: contain;
        background: #000;
      }
      .ptop,
      .pbot {
        position: absolute;
        left: 0;
        right: 0;
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 16px 20px;
        color: #fff;
      }
      .ptop,
      .pbot {
        transition: opacity 0.4s;
      }
      .player.quiet .ptop,
      .player.quiet .pbot {
        opacity: 0;
        pointer-events: none;
      }
      .ptop {
        top: 0;
        background: linear-gradient(rgba(0, 0, 0, 0.6), transparent);
      }
      .pbot {
        bottom: 96px;
      }
      .pn {
        font-size: 20px;
        font-weight: 600;
      }
      .pb {
        display: grid;
        place-items: center;
        width: 56px;
        height: 56px;
        border-radius: 50%;
        background: rgba(255, 255, 255, 0.14);
        color: #fff;
        --mdc-icon-size: 30px;
      }
      .pstatus {
        position: absolute;
        left: 50%;
        top: 50%;
        transform: translate(-50%, -50%);
        max-width: 70%;
        text-align: center;
        color: #fff;
        font-size: 18px;
        padding: 14px 20px;
        border-radius: 14px;
        background: rgba(0, 0, 0, 0.6);
      }
    `,
  ];
}

/** Parse an extended M3U playlist into channels. */
function parseM3u(text: string): Channel[] {
  const out: Channel[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l.startsWith("#EXTINF")) continue;
    let j = i + 1;
    while (j < lines.length && (lines[j].startsWith("#") || !lines[j].trim())) j++;
    const url = (lines[j] || "").trim();
    if (!/^https?:\/\//i.test(url)) continue;
    const attr = (k: string) => (l.match(new RegExp(`${k}="([^"]*)"`, "i")) || [])[1];
    const name = l.slice(l.lastIndexOf(",") + 1).trim().replace(/\s*\[(Geo-blocked|Not 24\/7)\]/gi, "");
    out.push({ name, url, logo: attr("tvg-logo") || undefined, groups: (attr("group-title") || "").split(";").map((g) => g.trim()).filter(Boolean) });
  }
  return out;
}

reg("panel-iptv", PageIptv);
