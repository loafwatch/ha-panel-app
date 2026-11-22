import { reg } from "../registry";
import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { tokens } from "../styles";
import type { DataHub, Reminder } from "../data";
import type { HomeAssistant, PanelConfig } from "../types";
import { binsInfo } from "../pages/bins";
import { timerLabel, timersOf } from "../pages/timers-state";
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
        this.timer = window.setInterval(() => (this.now = new Date()), 1000);
      }
    }
    if (changed.has("hub")) this.hub?.addEventListener("change", this.onHub);
  }

  private down = (e: PointerEvent) => {
    this.sx = e.clientX;
    this.sy = e.clientY;
  };

  /** Tapping a timer wakes straight onto the Timers page. */
  private toTimers = (e: PointerEvent) => {
    e.stopPropagation();
    this.dispatchEvent(new CustomEvent("panel-wake", { detail: { page: "timers" }, bubbles: true, composed: true }));
  };

  /** Tick a reminder off from the kiosk without waking it. */
  private tick(e: PointerEvent, r: Reminder) {
    e.stopPropagation();
    this.hub.markReminderDone(r);
    this.dispatchEvent(new CustomEvent("panel-toast", { detail: `Done: ${r.summary}`, bubbles: true, composed: true }));
  }

  /** Tapping "now playing" wakes straight onto the Music page. */
  private toMusic = (e: PointerEvent) => {
    e.stopPropagation();
    this.dispatchEvent(new CustomEvent("panel-wake", { detail: { page: "music" }, bubbles: true, composed: true }));
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
    // After 7pm the day's business is usually done, so look to tomorrow instead.
    const now = new Date();
    const from = now.getHours() >= 19 ? new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1) : now;
    const remCal = c.reminders?.calendar;
    const next = this.hub.events.find(
      (e) => e.calendar !== remCal && e.end.getTime() > from.getTime() && (now.getHours() < 19 || e.start.getTime() >= from.getTime()),
    );
    // family reminders stay until ticked off: today's, plus any missed from earlier days
    const rem = this.hub.reminders.filter((r) => !r.done);
    const bins = binsInfo(this.hass, c);
    // energy saving session: show today's (glowing while it's on) or the next one within two days
    const sv = this.hub.savings.find((e) => e.end > now && e.start.getTime() - now.getTime() < 2 * 86400000);
    const svLive = !!sv && sv.start <= now;
    // match day: the next home kick-off, shown from the morning until about 2½ hours after kick-off
    const mc = c.match;
    const ms = mc ? this.hass.states[mc.sensor] : undefined;
    const ko = ms && !["unknown", "unavailable", ""].includes(ms.state) ? new Date(ms.state) : undefined;
    const matchDay = !!ko && !isNaN(ko.getTime()) && ko.toDateString() === now.toDateString() && now.getTime() < ko.getTime() + 2.5 * 3600000;
    const tms = c.timers?.sensor ? timersOf(this.hass, c.timers.sensor).filter((t) => t.left > 0) : [];
    const np = c.now_playing ? this.hass.states[c.now_playing] : undefined;
    const playing = np?.state === "playing" && !!np.attributes.media_title;
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
          ${tms.map((t) => {
            const s = Math.max(0, Math.round(t.left));
            const mm = Math.floor(s / 60);
            const left = s >= 3600 ? `${Math.floor(s / 3600)}:${String(mm % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}` : `${mm}:${String(s % 60).padStart(2, "0")}`;
            const pct = t.total > 0 ? Math.min(100, Math.max(0, (1 - t.left / t.total) * 100)) : 0;
            return html`<div class="pill tm ${s <= 60 ? "soon" : ""}" style="--p:${pct}%" @pointerup=${this.toTimers}>
              <ha-icon icon="mdi:timer-outline"></ha-icon><span>${timerLabel(t.name)}</span><b>${left}</b>
            </div>`;
          })}
          ${playing
            ? html`<div class="pill np" @pointerup=${this.toMusic}>
                ${np!.attributes.entity_picture
                  ? html`<img src=${np!.attributes.entity_picture} alt="" />`
                  : html`<ha-icon icon="mdi:music"></ha-icon>`}
                <span class="npt"><b>${np!.attributes.media_title}</b>${np!.attributes.media_artist
                  ? html`<span>${np!.attributes.media_artist}</span>`
                  : nothing}</span>
                <span class="eq"><i></i><i></i><i></i></span>
              </div>`
            : nothing}
          ${matchDay && ko && mc
            ? html`<div class="pill match ${now >= ko ? "live" : ""}" style="--mc:${mc.color ?? "#2f6bff"}">
                <ha-icon icon=${mc.icon ?? "mdi:soccer"}></ha-icon>${now >= ko
                  ? `${mc.label ? mc.label + " " : ""}v ${ms!.attributes.opponent ?? ""} · on now`
                  : `${mc.label ? mc.label + " " : "Home "}v ${ms!.attributes.opponent ?? ""} · KO ${fmtTime(ko)}`}
              </div>`
            : nothing}
          ${sv
            ? html`<div class="pill save ${svLive ? "live" : ""}">
                <ha-icon icon=${svLive ? "mdi:lightning-bolt-circle" : "mdi:leaf"}></ha-icon>${svLive
                  ? `Saving session now · until ${fmtTime(sv.end)}`
                  : `Saving session ${dayLabel(sv.start)} ${fmtTime(sv.start)}–${fmtTime(sv.end)}`}
              </div>`
            : nothing}
          ${next
            ? html`<div class="pill"><ha-icon icon="mdi:calendar"></ha-icon>${dayLabel(next.start)}${next.allDay ? "" : " " + fmtTime(next.start)} · ${next.summary}</div>`
            : nothing}
          ${rem
            .slice(0, 4)
            .map((r) => {
              const today = r.start.toDateString() === now.toDateString();
              const when = today ? (r.allDay ? "" : fmtTime(r.start) + " · ") : dayLabel(r.start) + " · ";
              return html`<div class="pill rem ${r.start.getTime() <= now.getTime() ? "due" : ""} ${today ? "" : "late"}">
                <ha-icon icon="mdi:bell-outline"></ha-icon><span>${when}${r.summary}</span>
                <button class="tick" aria-label="Mark ${r.summary} done" @pointerup=${(e: PointerEvent) => this.tick(e, r)}>
                  <ha-icon icon="mdi:check"></ha-icon>
                </button>
              </div>`;
            })}
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
      .pill.tm {
        pointer-events: auto;
        cursor: pointer;
        position: relative;
        overflow: hidden;
        border: 2px solid #ff2e97;
        gap: 10px;
      }
      .pill.tm::before {
        content: "";
        position: absolute;
        inset: 0;
        width: var(--p);
        background: rgba(255, 46, 151, 0.28);
        transition: width 1s linear;
      }
      .pill.tm > * {
        position: relative;
      }
      .pill.tm b {
        font-size: 22px;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
        min-width: 3.2ch;
        text-align: right;
      }
      .pill.tm.soon {
        animation: binpulse 1s ease-in-out infinite;
        --bin: #ff2e97;
      }
      .pill.np {
        pointer-events: auto;
        cursor: pointer;
        padding: 6px 16px 6px 6px;
        max-width: 420px;
      }
      .pill.np img {
        width: 44px;
        height: 44px;
        border-radius: 50%;
        object-fit: cover;
        flex: none;
        animation: spin 12s linear infinite;
      }
      .npt {
        display: flex;
        flex-direction: column;
        min-width: 0;
      }
      .npt b,
      .npt span {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .npt span {
        font-size: 14px;
        opacity: 0.75;
      }
      .eq {
        display: flex;
        align-items: flex-end;
        gap: 3px;
        height: 18px;
        flex: none;
      }
      .eq i {
        width: 3px;
        background: #ff2e97;
        border-radius: 2px;
        animation: eq 0.9s ease-in-out infinite;
      }
      .eq i:nth-child(2) {
        background: #00c8d4;
        animation-delay: -0.3s;
      }
      .eq i:nth-child(3) {
        animation-delay: -0.6s;
      }
      @keyframes eq {
        0%,
        100% {
          height: 4px;
        }
        50% {
          height: 18px;
        }
      }
      @keyframes spin {
        to {
          transform: rotate(360deg);
        }
      }
      .pill.rem {
        pointer-events: auto;
        padding-right: 6px;
      }
      .pill.rem > ha-icon {
        color: #3ddc84;
      }
      .pill.rem.late {
        border-color: #ffb547;
      }
      .pill.rem.late > ha-icon {
        color: #ffb547;
      }
      .pill.rem .tick {
        display: grid;
        place-items: center;
        width: 40px;
        height: 40px;
        margin-left: 6px;
        border-radius: 50%;
        border: 2px solid currentColor;
        background: rgba(255, 255, 255, 0.08);
        color: #3ddc84;
        cursor: pointer;
        --mdc-icon-size: 22px;
      }
      .pill.rem.due {
        border-color: #3ddc84;
        box-shadow: 0 0 16px rgba(61, 220, 132, 0.45);
      }
      .pill.match {
        border: 2px solid var(--mc);
        box-shadow: 0 0 14px color-mix(in srgb, var(--mc) 55%, transparent);
      }
      .pill.match ha-icon {
        color: color-mix(in srgb, var(--mc) 60%, white);
      }
      .pill.match.live {
        animation: matchpulse 2s ease-in-out infinite;
      }
      @keyframes matchpulse {
        50% {
          box-shadow: 0 0 0 3px var(--mc), 0 0 24px var(--mc);
        }
      }
      .pill.save {
        border: 2px solid #00c8d4;
      }
      .pill.save ha-icon {
        color: #00e5f0;
      }
      .pill.save.live {
        animation: savepulse 2s ease-in-out infinite;
      }
      @keyframes savepulse {
        50% {
          box-shadow: 0 0 0 3px #00c8d4, 0 0 24px #00c8d4;
        }
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
