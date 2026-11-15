import { reg } from "../registry";
import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { tokens } from "../styles";
import type { DataHub } from "../data";
import type { HomeAssistant, PanelConfig } from "../types";
import { binsInfo } from "../pages/bins";
import { WEATHER_ICON, dayLabel, fmtDay, fmtTime, weatherLabel } from "../util";

/**
 * Photo screensaver: a photo frame (e.g. Immich Kiosk) with the time, weather,
 * next event, reminders and bin reminder on top. Swipe for the next photo, tap to wake.
 */
export class PanelScreensaver extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ attribute: false }) config!: PanelConfig;
  @property({ attribute: false }) hub!: DataHub;
  @property({ type: Boolean, reflect: true }) open = false;
  @state() private n = 0;
  @state() private now = new Date();
  private timer?: number;
  private sx = 0;
  private sy = 0;
  private onHub = () => this.open && this.requestUpdate();

  connectedCallback() {
    super.connectedCallback();
    this.hub?.addEventListener("change", this.onHub);
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    this.hub?.removeEventListener("change", this.onHub);
    window.clearInterval(this.timer);
  }

  protected shouldUpdate(changed: PropertyValues) {
    if (changed.size === 1 && changed.has("hass")) return this.open;
    return true;
  }

  protected updated(changed: PropertyValues) {
    if (changed.has("open")) {
      window.clearInterval(this.timer);
      if (this.open) {
        this.now = new Date();
        this.timer = window.setInterval(() => (this.now = new Date()), 15000);
      }
    }
    if (changed.has("hub")) this.hub?.addEventListener("change", this.onHub);
  }

  private down = (e: PointerEvent) => {
    this.sx = e.clientX;
    this.sy = e.clientY;
  };

  private up = (e: PointerEvent) => {
    const dx = e.clientX - this.sx;
    const dy = e.clientY - this.sy;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      this.n++; // next photo
      return;
    }
    if (Math.abs(dx) < 15 && Math.abs(dy) < 15) {
      this.dispatchEvent(new CustomEvent("panel-wake", { bubbles: true, composed: true }));
    }
  };

  render() {
    if (!this.open) return nothing;
    const c = this.config;
    const w = c.weather ? this.hass.states[c.weather] : undefined;
    const next = this.hub.events.find((e) => e.end.getTime() > Date.now());
    const rem = (c.todo_lists?.[0] ? this.hub.todos[c.todo_lists[0].entity] ?? [] : []).filter((i) => i.status === "needs_action");
    const bins = binsInfo(this.hass, c);
    const url = c.photos?.url ? c.photos.url + (c.photos.url.includes("?") ? "&" : "?") + "n=" + this.n : "";
    return html`
      <div class="ss">
        ${url ? html`<iframe src=${url} title="Photos" tabindex="-1"></iframe>` : html`<div class="noframe"></div>`}
        <div class="shade"></div>
        <div class="hit" @pointerdown=${this.down} @pointerup=${this.up}></div>
        <div class="info">
          <div class="time">${fmtTime(this.now)}</div>
          <div class="date">${fmtDay(this.now)}</div>
          ${w
            ? html`<div class="wx"><ha-icon icon=${WEATHER_ICON[w.state] ?? "mdi:weather-cloudy"}></ha-icon>${Math.round(w.attributes.temperature)}°
                <span>${weatherLabel(w.state)}</span></div>`
            : nothing}
        </div>
        <div class="side">
          ${bins?.due
            ? html`<div class="pill bin" style="--bin:${bins.next?.color ?? "#ff2e97"}"><ha-icon icon="mdi:trash-can-outline"></ha-icon>${bins.next?.name ?? "Bin"} out tonight</div>`
            : nothing}
          ${next
            ? html`<div class="pill"><ha-icon icon="mdi:calendar"></ha-icon>${dayLabel(next.start)}${next.allDay ? "" : " " + fmtTime(next.start)} · ${next.summary}</div>`
            : nothing}
          ${rem.slice(0, 3).map((r) => html`<div class="pill"><ha-icon icon="mdi:bell-outline"></ha-icon>${r.summary}</div>`)}
        </div>
      </div>
    `;
  }

  static styles = [
    tokens,
    css`
      :host {
        position: fixed;
        inset: 0;
        z-index: 40;
        pointer-events: none;
      }
      :host([open]) {
        pointer-events: auto;
      }
      .ss {
        position: absolute;
        inset: 0;
        background: #000;
        animation: fade 0.6s ease-out;
        font-family: var(--font);
        color: #fff;
      }
      @keyframes fade {
        from {
          opacity: 0;
        }
      }
      iframe {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        border: 0;
      }
      .noframe {
        position: absolute;
        inset: 0;
        background: radial-gradient(circle at 30% 20%, #3a1660, #0a0414 70%);
      }
      .shade {
        position: absolute;
        inset: 0;
        background: linear-gradient(180deg, rgba(0, 0, 0, 0.45), transparent 30%, transparent 62%, rgba(0, 0, 0, 0.55));
        pointer-events: none;
      }
      .hit {
        position: absolute;
        inset: 0;
        touch-action: none;
      }
      .info {
        position: absolute;
        left: 40px;
        bottom: 34px;
        pointer-events: none;
        text-shadow: 0 2px 12px rgba(0, 0, 0, 0.6);
      }
      .time {
        font-size: 104px;
        font-weight: 300;
        line-height: 1;
        letter-spacing: -0.02em;
      }
      .date {
        font-size: 24px;
        margin-top: 8px;
        opacity: 0.9;
      }
      .wx {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-top: 12px;
        font-size: 28px;
        font-weight: 600;
      }
      .wx span {
        font-size: 20px;
        font-weight: 400;
        opacity: 0.85;
      }
      .wx ha-icon {
        --mdc-icon-size: 34px;
      }
      .side {
        position: absolute;
        right: 32px;
        bottom: 34px;
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 10px;
        max-width: 45%;
        pointer-events: none;
      }
      .pill {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 10px 18px;
        border-radius: 999px;
        background: rgba(10, 4, 20, 0.55);
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
        font-size: 17px;
        line-height: 1.3;
      }
      .pill ha-icon {
        --mdc-icon-size: 20px;
        flex: 0 0 auto;
      }
      .pill.bin {
        border: 2px solid var(--bin);
        animation: binpulse 2s ease-in-out infinite;
      }
      @keyframes binpulse {
        50% {
          box-shadow: 0 0 0 3px var(--bin), 0 0 22px var(--bin);
        }
      }
    `,
  ];
}

reg("panel-screensaver", PanelScreensaver);
