import { reg } from "./registry";
import { LitElement, css, nothing, type PropertyValues } from "lit";
import { html, unsafeStatic } from "lit/static-html.js";
import { property, query, state } from "lit/decorators.js";
import { DataHub } from "./data";
import { tokens } from "./styles";
import type { HomeAssistant, PageId, PanelConfig, PanelInfo } from "./types";
import "./pages/home";
import "./pages/music";
import "./pages/calendar";
import "./pages/weather";
import "./pages/lights";
import "./pages/timers";
import "./pages/energy";
import "./pages/media";
import "./pages/transit";
import "./pages/tv";
import "./pages/recipes";
import "./pages/iptv";
import "./pages/settings";
import "./components/voice";
import "./components/screensaver";
import "./components/volume";
import "./components/lyrics";

declare const __HPA_VERSION__: string;
export const VERSION = __HPA_VERSION__;

interface PageDef {
  id: PageId;
  label: string;
  icon: string;
  tag: string;
  needs: (c: PanelConfig) => boolean;
}

const ALL: Record<string, PageDef> = Object.fromEntries(
  ([
    { id: "home", label: "Home", icon: "mdi:home-variant", tag: "panel-home", needs: () => true },
    { id: "music", label: "Music", icon: "mdi:music", tag: "panel-music", needs: (c) => !!c.music?.rooms?.length },
    { id: "tv", label: "TV remote", icon: "mdi:remote-tv", tag: "panel-tv", needs: (c) => !!c.tv?.length },
    { id: "iptv", label: "Live TV", icon: "mdi:television-play", tag: "panel-iptv", needs: (c) => !!c.iptv?.playlist },
    { id: "media", label: "Media", icon: "mdi:play-box-multiple", tag: "panel-media", needs: (c) => !!c.media?.url },
    { id: "recipes", label: "Recipes", icon: "mdi:chef-hat", tag: "panel-recipes", needs: (c) => !!c.recipes },
    { id: "timers", label: "Timers", icon: "mdi:timer-outline", tag: "panel-timers", needs: (c) => !!c.timers },
    { id: "calendar", label: "Calendar", icon: "mdi:calendar-month", tag: "panel-calendar", needs: (c) => !!c.calendars?.length },
    { id: "weather", label: "Weather", icon: "mdi:weather-partly-cloudy", tag: "panel-weather", needs: (c) => !!c.weather },
    { id: "energy", label: "Utilities", icon: "mdi:lightning-bolt", tag: "panel-energy", needs: (c) => !!c.energy },
    { id: "transit", label: "Tram", icon: "mdi:tram", tag: "panel-transit", needs: (c) => !!c.transit?.stops?.length },
    { id: "lights", label: "Rooms", icon: "mdi:sofa-outline", tag: "panel-lights", needs: (c) => !!c.lights?.length },
    { id: "settings", label: "Settings", icon: "mdi:cog", tag: "panel-settings", needs: (c) => !!c.voice_match || !!c.photos?.album_entity },
  ] as PageDef[]).map((p) => [p.id, p]),
);

/** The dock: single pages, and groups whose pages appear as tabs along the top. */
const DOCK: DockDef[] = [
  { id: "home", tabs: ["home"] },
  { id: "rooms", label: "Rooms", icon: "mdi:sofa-outline", tabs: ["lights"] },
  { id: "music", tabs: ["music"] },
  { id: "watch", label: "Watch", icon: "mdi:television-play", tabs: ["tv", "iptv", "media"] },
  { id: "kitchen", label: "Kitchen", icon: "mdi:silverware-fork-knife", tabs: ["recipes", "timers"] },
  { id: "calendar", tabs: ["calendar"] },
  { id: "info", label: "Info", icon: "mdi:information-outline", tabs: ["weather", "energy", "transit"] },
  { id: "settings", tabs: ["settings"] },
];

interface DockDef {
  id: string;
  label?: string;
  icon?: string;
  tabs: PageId[];
}

/** A dock entry with the pages this install actually has. */
interface Slot {
  id: string;
  label: string;
  icon: string;
  tabs: PageDef[];
}

/**
 * Root element registered as a Home Assistant custom panel.
 * Pages sit side by side and snap as you swipe; the dock jumps between them.
 */
export class HaPanelApp extends LitElement {
  @property({ attribute: false }) hass?: HomeAssistant;
  @property({ attribute: false }) panel?: PanelInfo;
  @property({ type: Boolean }) narrow = false;
  @property({ type: Boolean, reflect: true }) dark = false;

  @state() private index = 0;
  @state() private saver = false;
  @state() private toastMsg = "";
  @query(".pager") private pager?: HTMLElement;

  private hub = new DataHub();
  private idleTimer?: number;
  private toastTimer?: number;
  private lastPageValue?: string;
  /** Set while the user drags something sideways inside a page (slider, carousel), so a
   *  kiosk app's swipe event for that drag doesn't also change page. */
  private holdSwipeUntil = 0;
  private scrollEnd?: number;

  private get config(): PanelConfig {
    return this.panel?.config ?? {};
  }
  private get pages(): Slot[] {
    const c = this.config;
    return DOCK.map((d) => {
      const tabs = d.tabs.map((t) => ALL[t]).filter((p) => p && p.needs(c));
      return { id: d.id, label: d.label ?? tabs[0]?.label ?? d.id, icon: d.icon ?? tabs[0]?.icon ?? "mdi:circle", tabs };
    }).filter((s) => s.tabs.length);
  }

  /** Selected tab per dock group. */
  @state() private tabSel: Record<string, string> = {};

  private tabOf(s: Slot): string {
    const t = this.tabSel[s.id];
    return s.tabs.some((p) => p.id === t) ? t : s.tabs[0].id;
  }

  connectedCallback() {
    super.connectedCallback();
    this.addEventListener("panel-navigate", this.onNavigate as EventListener);
    this.addEventListener("panel-toast", this.onToast as EventListener);
    this.addEventListener("panel-wake", this.wake);
    this.addEventListener("panel-keep-awake", this.onKeepAwake as EventListener);
    window.addEventListener("pointerdown", this.activity, { capture: true, passive: true });
    this.addEventListener("pointerdown", this.onPointerDown, { capture: true, passive: true });
    this.addEventListener("pointermove", this.onPointerMove, { capture: true, passive: true });
    this.applyKiosk();
    this.resetIdle();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("pointerdown", this.activity, { capture: true });
    window.clearTimeout(this.idleTimer);
    this.hub.stop();
  }

  private kioskApplied = false;

  /** Hide Home Assistant's sidebar on the wall tablet (config `kiosk: true` or `?kiosk` in the URL). */
  private applyKiosk() {
    if (this.kioskApplied) return;
    const want = this.config.kiosk || new URLSearchParams(location.search).has("kiosk");
    if (!want) return;
    this.kioskApplied = true;
    this.dispatchEvent(new CustomEvent("hass-dock-sidebar", { detail: { dock: "always_hidden" }, bubbles: true, composed: true }));
  }

  protected willUpdate(changed: PropertyValues) {
    if (!this.hass) return;
    if (changed.has("panel")) this.applyKiosk();
    this.dark = !!this.hass.themes?.darkMode;
    if (changed.has("panel") || !changed.get("hass")) this.hub.start(this.hass, this.config);
    this.hub.update(this.hass);
    if (changed.has("panel")) this.resetIdle();
    this.syncPageEntity();
  }

  // ---------- navigation ----------

  private goTo(id: string, smooth = true) {
    if (id === "photos") {
      this.saver = true;
      return;
    }
    const pages = this.pages;
    let i = pages.findIndex((p) => p.id === id);
    if (i < 0) {
      i = pages.findIndex((p) => p.tabs.some((t) => t.id === id));
      if (i < 0) return;
      this.tabSel = { ...this.tabSel, [pages[i].id]: id };
    }
    this.saver = false;
    this.index = i;
    const el = this.pager;
    if (el) el.scrollTo({ left: i * el.clientWidth, behavior: smooth ? "smooth" : "auto" });
  }

  private onNavigate = (e: CustomEvent<string>) => this.goTo(e.detail);

  private holding = false;

  private onPointerDown = (e: PointerEvent) => {
    this.holding = e.composedPath().some((n) => {
      if (!(n instanceof HTMLElement)) return false;
      if (n instanceof HTMLInputElement && n.type === "range") return true;
      if (n.classList.contains("pager")) return false;
      const cs = getComputedStyle(n);
      return /auto|scroll/.test(cs.overflowX) && n.scrollWidth > n.clientWidth + 2;
    });
    if (this.holding) this.holdSwipeUntil = Date.now() + 1500;
  };

  private onPointerMove = () => {
    if (this.holding) this.holdSwipeUntil = Date.now() + 1500;
  };

  private onScroll = () => {
    window.clearTimeout(this.scrollEnd);
    this.scrollEnd = window.setTimeout(() => {
      const el = this.pager;
      if (!el || !el.clientWidth) return;
      const i = Math.round(el.scrollLeft / el.clientWidth);
      if (i !== this.index) this.index = i;
    }, 80);
  };

  /** An automation can set the page entity to e.g. "music" or "photos", or to "next" / "prev"
   *  to step between pages (handy for kiosk apps that report swipes as events). A suffix after
   *  "|" (e.g. "home|1731667200") lets the same value be sent twice in a row. */
  private syncPageEntity() {
    const id = this.config.page_entity;
    if (!id || !this.hass) return;
    const v = this.hass.states[id]?.state;
    if (v === undefined || v === this.lastPageValue) return;
    const first = this.lastPageValue === undefined;
    this.lastPageValue = v;
    if (first) return; // don't jump on load
    const page = v.split("|")[0].trim().toLowerCase();
    if (!page) return;
    if (page === "rdone") {
      // "rdone|<start epoch s>|<title>": a reminder ticked off from a phone notification
      const [, ts, ...rest] = v.split("|");
      this.hub.markReminderDoneAt(Number(ts) * 1000, rest.join("|"));
      return;
    }
    window.setTimeout(() => {
      if (page === "next" || page === "prev") {
        if (this.saver || Date.now() < this.holdSwipeUntil) return;
        // swiping back past the first page returns to the photo screensaver
        if (page === "prev" && this.index === 0) {
          this.saver = true;
          return;
        }
        // ...and swiping on past the last page does too
        if (page === "next" && this.index === this.pages.length - 1) {
          this.saver = true;
          return;
        }
        const to = Math.max(0, Math.min(this.pages.length - 1, this.index + (page === "next" ? 1 : -1)));
        this.goTo(this.pages[to].id);
      } else this.goTo(page);
    }, 0);
  }

  // ---------- idle / screensaver ----------

  private activity = () => {
    if (!this.saver) this.resetIdle();
  };

  private resetIdle() {
    window.clearTimeout(this.idleTimer);
    const s = this.config.idle_seconds ?? 0;
    if (s > 0) this.idleTimer = window.setTimeout(() => this.idle(), s * 1000);
  }

  /** Things on screen the user is watching without touching (lyrics, live TV). */
  private awake = new Set<HTMLElement>();

  private onKeepAwake = (e: CustomEvent<{ on: boolean }>) => {
    const src = e.composedPath()[0] as HTMLElement;
    if (e.detail.on) this.awake.add(src);
    else this.awake.delete(src);
  };

  private idle() {
    for (const el of this.awake) if (!el.isConnected) this.awake.delete(el);
    const voice = this.renderRoot.querySelector("panel-voice") as unknown as { open?: boolean } | null;
    const alarm = this.config.timers?.alarm_switch;
    const ringing = !!alarm && this.hass?.states[alarm]?.state === "on";
    const cur = this.pages[this.index];
    const watching = !!cur && this.tabOf(cur) === "media";
    if (voice?.open || ringing || watching || this.awake.size) return this.resetIdle();
    this.saver = true;
  }

  private wake = (e?: Event) => {
    // the tap that wakes the panel must not also land on whatever is underneath it
    const swallow = (ev: Event) => {
      ev.stopPropagation();
      ev.preventDefault();
    };
    window.addEventListener("click", swallow, true);
    window.setTimeout(() => window.removeEventListener("click", swallow, true), 450);
    this.saver = false;
    const page = (e as CustomEvent<{ page?: string }> | undefined)?.detail?.page;
    this.goTo(page ?? this.config.home_page ?? "home", false);
    this.resetIdle();
  };

  // ---------- toast ----------

  private onToast = (e: CustomEvent<string>) => {
    this.toastMsg = e.detail;
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => (this.toastMsg = ""), 2600);
  };

  // ---------- render ----------

  render() {
    if (!this.hass) return html`<div class="loading">Connecting…</div>`;
    const pages = this.pages;
    return html`
      <div class="pager" @scroll=${this.onScroll}>
        ${pages.map((p, i) => {
          const sel = this.tabOf(p);
          const live = i === this.index && !this.saver;
          return html`<section class="slot ${p.tabs.length > 1 ? "grouped" : ""}" aria-label=${p.label}>
            ${p.tabs.length > 1
              ? html`<div class="tabs" role="tablist">
                  ${p.tabs.map(
                    (t) => html`<button role="tab" class="tab ${t.id === sel ? "on" : ""}" aria-selected=${t.id === sel} @click=${() => (this.tabSel = { ...this.tabSel, [p.id]: t.id })}>
                      <ha-icon icon=${t.icon}></ha-icon>${t.label}
                    </button>`,
                  )}
                </div>`
              : nothing}
            ${p.tabs.map((t) => {
              const tag = unsafeStatic(t.tag);
              return html`<${tag} class=${t.id === sel ? "" : "hidden"} .hass=${this.hass} .config=${this.config} .hub=${this.hub} ?active=${live && t.id === sel} ?dark=${this.dark}></${tag}>`;
            })}
          </section>`;
        })}
      </div>
      <nav class="dock">
        ${pages.map(
          (p, i) => html`<button class="dk ${i === this.index ? "on" : ""}" aria-label=${p.label} @click=${() => this.goTo(p.id)}>
            <ha-icon icon=${p.icon}></ha-icon><span>${p.label}</span>
          </button>`
        )}
      </nav>
      <div class="toast ${this.toastMsg ? "show" : ""}">${this.toastMsg || nothing}</div>
      <panel-screensaver .hass=${this.hass} .config=${this.config} .hub=${this.hub} ?open=${this.saver}></panel-screensaver>
      <panel-voice .hass=${this.hass} .config=${this.config} ?dark=${this.dark}></panel-voice>
    `;
  }

  static styles = [
    tokens,
    css`
      :host {
        display: block;
        position: relative;
        height: 100vh;
        height: 100dvh;
        overflow: hidden;
        background: var(--bg);
        color: var(--text);
        font-family: var(--font);
        -webkit-font-smoothing: antialiased;
      }
      .loading {
        display: flex;
        height: 100%;
        align-items: center;
        justify-content: center;
        color: var(--text-2);
      }
      .pager {
        display: flex;
        height: 100%;
        overflow-x: auto;
        overflow-y: hidden;
        scroll-snap-type: x mandatory;
        scrollbar-width: none;
        overscroll-behavior: contain;
        -webkit-overflow-scrolling: touch;
      }
      .pager::-webkit-scrollbar {
        display: none;
      }
      .slot {
        flex: 0 0 100%;
        height: 100%;
        scroll-snap-align: start;
        scroll-snap-stop: always;
        position: relative;
        overflow: hidden;
      }
      .slot > * {
        display: block;
        height: 100%;
        /* pages that position things absolutely (Media's iframe, Live TV) stay below the tabs */
        position: relative;
      }
      .slot.grouped {
        display: flex;
        flex-direction: column;
      }
      .slot.grouped > :not(.tabs) {
        flex: 1;
        min-height: 0;
        height: auto;
      }
      .slot > .hidden {
        display: none !important;
      }
      .tabs {
        flex: none;
        display: flex;
        justify-content: center;
        gap: 8px;
        padding: 14px 16px 0;
        height: auto !important;
      }
      .tab {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 10px 18px;
        border-radius: 999px;
        border: 1px solid var(--line);
        background: var(--tile);
        color: var(--text-2);
        font: 600 16px var(--font);
        --mdc-icon-size: 22px;
        cursor: pointer;
        -webkit-tap-highlight-color: transparent;
      }
      .tab.on {
        background: var(--grad);
        border-color: transparent;
        color: #fff;
      }
      .dock {
        position: absolute;
        left: 50%;
        bottom: 14px;
        transform: translateX(-50%);
        z-index: 10;
        display: flex;
        gap: 6px;
        padding: 7px;
        border-radius: 999px;
        background: var(--dock);
        backdrop-filter: blur(14px);
        -webkit-backdrop-filter: blur(14px);
        box-shadow: var(--glow), 0 8px 30px rgba(0, 0, 0, 0.18);
        max-width: calc(100% - 24px);
        overflow-x: auto;
        scrollbar-width: none;
      }
      .dk {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 12px 18px;
        border-radius: 999px;
        border: none;
        background: none;
        color: var(--text-2);
        font: 600 16px var(--font);
        --mdc-icon-size: 30px;
        cursor: pointer;
        white-space: nowrap;
        transition: background 0.25s, color 0.25s;
        -webkit-tap-highlight-color: transparent;
      }
      .dk span {
        display: none;
      }
      .dk.on {
        background: var(--grad);
        color: #fff;
      }
      .dk.on span {
        display: inline;
      }
      .toast {
        position: absolute;
        left: 50%;
        bottom: 100px;
        transform: translate(-50%, 12px);
        opacity: 0;
        z-index: 30;
        pointer-events: none;
        padding: 11px 20px;
        border-radius: 999px;
        background: rgba(20, 8, 36, 0.92);
        color: #fff;
        border: 1px solid var(--pk);
        box-shadow: 0 0 14px rgba(255, 46, 151, 0.45);
        font-size: 15px;
        font-weight: 600;
        white-space: nowrap;
        transition: all 0.25s;
      }
      .toast.show {
        opacity: 1;
        transform: translate(-50%, 0);
      }
    `,
  ];
}

reg("ha-panel-app", HaPanelApp);

declare global {
  interface HTMLElementTagNameMap {
    "ha-panel-app": HaPanelApp;
  }
}
