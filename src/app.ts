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
import "./components/voice";
import "./components/screensaver";

declare const __HPA_VERSION__: string;
export const VERSION = __HPA_VERSION__;

interface PageDef {
  id: PageId;
  label: string;
  icon: string;
  tag: string;
  needs: (c: PanelConfig) => boolean;
}

const PAGES: PageDef[] = [
  { id: "home", label: "Home", icon: "mdi:home-variant", tag: "panel-home", needs: () => true },
  { id: "music", label: "Music", icon: "mdi:music", tag: "panel-music", needs: (c) => !!c.music?.rooms?.length },
  { id: "calendar", label: "Calendar", icon: "mdi:calendar-month", tag: "panel-calendar", needs: (c) => !!c.calendars?.length },
  { id: "weather", label: "Weather", icon: "mdi:weather-partly-cloudy", tag: "panel-weather", needs: (c) => !!c.weather },
  { id: "lights", label: "Lights", icon: "mdi:lightbulb-group", tag: "panel-lights", needs: (c) => !!c.lights?.length },
  { id: "timers", label: "Timers", icon: "mdi:timer-outline", tag: "panel-timers", needs: (c) => !!c.timers },
  { id: "energy", label: "Energy", icon: "mdi:lightning-bolt", tag: "panel-energy", needs: (c) => !!c.energy },
  { id: "media", label: "Media", icon: "mdi:play-box-multiple", tag: "panel-media", needs: (c) => !!c.media?.url },
];

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
  private scrollEnd?: number;
  private drag?: { x: number; y: number; left: number; dx: number; lock?: "x" | "y"; t: number };

  private get config(): PanelConfig {
    return this.panel?.config ?? {};
  }
  private get pages(): PageDef[] {
    return PAGES.filter((p) => p.needs(this.config));
  }

  connectedCallback() {
    super.connectedCallback();
    this.addEventListener("panel-navigate", this.onNavigate as EventListener);
    this.addEventListener("panel-toast", this.onToast as EventListener);
    this.addEventListener("panel-wake", this.wake);
    window.addEventListener("pointerdown", this.activity, { capture: true, passive: true });
    if (new URLSearchParams(location.search).has("kiosk")) {
      // Hide Home Assistant's sidebar on the wall tablet.
      this.dispatchEvent(new CustomEvent("hass-dock-sidebar", { detail: { dock: "always_hidden" }, bubbles: true, composed: true }));
    }
    this.resetIdle();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("pointerdown", this.activity, { capture: true });
    window.clearTimeout(this.idleTimer);
    this.hub.stop();
  }

  protected willUpdate(changed: PropertyValues) {
    if (!this.hass) return;
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
    const i = this.pages.findIndex((p) => p.id === id);
    if (i < 0) return;
    this.saver = false;
    this.index = i;
    const el = this.pager;
    if (el) el.scrollTo({ left: i * el.clientWidth, behavior: smooth ? "smooth" : "auto" });
  }

  private onNavigate = (e: CustomEvent<string>) => this.goTo(e.detail);

  private onScroll = () => {
    window.clearTimeout(this.scrollEnd);
    this.scrollEnd = window.setTimeout(() => {
      const el = this.pager;
      if (!el || !el.clientWidth) return;
      const i = Math.round(el.scrollLeft / el.clientWidth);
      if (i !== this.index) this.index = i;
    }, 80);
  };

  // ---------- two-finger swipe ----------
  // One page per gesture: two fingers moving sideways flips to the next or
  // previous page, and nothing else happens until the fingers lift.

  private get twoFinger() {
    return this.config.swipe_fingers === 2;
  }

  private mid(e: TouchEvent) {
    const a = e.touches[0];
    const b = e.touches[1];
    return { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
  }

  private onTouchStart = (e: TouchEvent) => {
    if (!this.twoFinger) return;
    if (e.touches.length === 2) {
      const m = this.mid(e);
      this.drag = { x: m.x, y: m.y, left: 0, dx: 0, t: performance.now() };
    } else if (e.touches.length > 2) {
      this.drag = undefined;
    }
  };

  private onTouchMove = (e: TouchEvent) => {
    const d = this.drag;
    if (!d || e.touches.length !== 2) return;
    const m = this.mid(e);
    const dx = m.x - d.x;
    const dy = m.y - d.y;
    if (!d.lock) {
      if (Math.hypot(dx, dy) < 14) return;
      d.lock = Math.abs(dx) > Math.abs(dy) * 1.2 ? "x" : "y";
    }
    if (d.lock !== "x") return;
    e.preventDefault();
    if (d.dx) return; // already flipped for this gesture
    if (Math.abs(dx) < 60) return;
    d.dx = dx;
    const to = Math.max(0, Math.min(this.pages.length - 1, this.index + (dx < 0 ? 1 : -1)));
    if (to !== this.index) this.goTo(this.pages[to].id);
  };

  private onTouchEnd = (e: TouchEvent) => {
    if (e.touches.length === 0) this.drag = undefined;
  };

  /** An automation can set the page entity to e.g. "music" or "photos". A suffix after "|"
   *  (e.g. "home|1731667200") lets the same page be requested twice in a row. */
  private syncPageEntity() {
    const id = this.config.page_entity;
    if (!id || !this.hass) return;
    const v = this.hass.states[id]?.state;
    if (v === undefined || v === this.lastPageValue) return;
    const first = this.lastPageValue === undefined;
    this.lastPageValue = v;
    if (first) return; // don't jump on load
    const page = v.split("|")[0].trim().toLowerCase();
    if (page) window.setTimeout(() => this.goTo(page), 0);
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

  private idle() {
    const voice = this.renderRoot.querySelector("panel-voice") as unknown as { open?: boolean } | null;
    const alarm = this.config.timers?.alarm_switch;
    const ringing = !!alarm && this.hass?.states[alarm]?.state === "on";
    const watching = this.pages[this.index]?.id === "media";
    if (voice?.open || ringing || watching) return this.resetIdle();
    this.saver = true;
  }

  private wake = () => {
    this.saver = false;
    this.goTo(this.config.home_page ?? "home", false);
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
      <div
        class="pager ${this.twoFinger ? "two" : ""}"
        @scroll=${this.onScroll}
        @touchstart=${{ handleEvent: this.onTouchStart, passive: true }}
        @touchmove=${{ handleEvent: this.onTouchMove, passive: false }}
        @touchend=${{ handleEvent: this.onTouchEnd, passive: true }}
        @touchcancel=${{ handleEvent: this.onTouchEnd, passive: true }}
      >
        ${pages.map((p, i) => {
          const tag = unsafeStatic(p.tag);
          return html`<section class="slot" aria-label=${p.label}>
            <${tag} .hass=${this.hass} .config=${this.config} .hub=${this.hub} ?active=${i === this.index && !this.saver} ?dark=${this.dark}></${tag}>
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
      /* two-finger mode: one finger never moves between pages */
      .pager.two {
        overflow-x: hidden;
        touch-action: pan-y;
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
      }
      .dock {
        position: absolute;
        left: 50%;
        bottom: 14px;
        transform: translateX(-50%);
        z-index: 10;
        display: flex;
        gap: 4px;
        padding: 6px;
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
        gap: 6px;
        padding: 10px 14px;
        border-radius: 999px;
        border: none;
        background: none;
        color: var(--text-2);
        font: 600 14px var(--font);
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
        bottom: 88px;
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
