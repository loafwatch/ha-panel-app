import { reg } from "../registry";
import { css, html, nothing } from "lit";
import { PageBase } from "./base";
import { timersOf, cancelTimer } from "./timers-state";
import { call, fmtCountdown, isOn } from "../util";

export class PageTimers extends PageBase {
  protected ticks = true;

  protected watched() {
    const t = this.config.timers;
    return [t?.sensor, t?.alarm_switch].filter(Boolean) as string[];
  }

  private start(m: number) {
    const t = this.config.timers!;
    call(this.hass, "view_assist", "set_timer", { entity_id: t.sensor, type: "Timer", name: `${m} min`, time: `${m} minute${m === 1 ? "" : "s"}` });
    this.toast(`Timer set for ${m} minute${m === 1 ? "" : "s"}`);
  }

  render() {
    const t = this.config.timers;
    if (!t) return html`<div class="page"><div class="empty">Timers aren't configured.</div></div>`;
    const list = timersOf(this.hass, t.sensor);
    const ringing = isOn(this.st(t.alarm_switch));
    // one timer fills the page, two split it, more share a grid
    const n = list.length;
    const cols = n <= 3 ? Math.max(1, n) : n <= 4 ? 2 : n <= 6 ? 3 : 4;
    const rows = Math.max(1, Math.ceil(n / cols));
    return html`
      <div class="page fill">
        ${ringing
          ? html`<button class="ring" @click=${() => call(this.hass, "switch", "turn_off", { entity_id: t.alarm_switch })}>
              <ha-icon icon="mdi:alarm-off"></ha-icon>Stop alarm
            </button>`
          : nothing}
        <div class="timers" style="grid-template-columns:repeat(${cols},minmax(0,1fr));grid-template-rows:repeat(${rows},minmax(0,1fr))">
          ${list.length
            ? list.map((x) => {
                const frac = x.total > 0 ? Math.max(0, Math.min(1, x.left / x.total)) : 1;
                const C = 2 * Math.PI * 92;
                return html`<div class="tile timer ${x.left < 10 ? "soon" : ""}">
                  <div class="ringwrap">
                    <svg viewBox="0 0 200 200" class="ringsvg">
                      <circle cx="100" cy="100" r="92" class="track"></circle>
                      <circle cx="100" cy="100" r="92" class="prog" style="stroke-dasharray:${C};stroke-dashoffset:${C * (1 - frac)}"></circle>
                    </svg>
                    <div class="inner">
                      <div class="left">${fmtCountdown(x.left)}</div>
                      <div class="tname muted">${x.name}</div>
                    </div>
                  </div>
                  <div class="tbtns">
                    ${t.add_minute_script
                      ? html`<button class="btn" @click=${() => call(this.hass, "script", "turn_on", { entity_id: t.add_minute_script, variables: { timer_id: x.id, minutes: 1 } })}>+1 min</button>`
                      : nothing}
                    <button class="btn" @click=${() => cancelTimer(this.hass, this.config, x.id, x.name)}>Cancel</button>
                  </div>
                </div>`;
              })
            : html`<div class="tile none"><ha-icon icon="mdi:timer-sand-empty"></ha-icon>
                <div>No timers running</div><div class="muted">Tap below, or say “Hey Jarvis, set a timer for 5 minutes”.</div></div>`}
        </div>
        <div class="label start"><ha-icon icon="mdi:timer-plus-outline"></ha-icon>Start a timer</div>
        <div class="quick">
          ${(t.quick ?? [1, 3, 5, 10, 15]).map((m) => html`<button class="q" @click=${() => this.start(m)}><b>${m}</b><span>min</span></button>`)}
        </div>
      </div>
    `;
  }

  static styles = [
    PageBase.styles,
    css`
      .ring {
        width: 100%;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 12px;
        padding: 22px;
        margin-bottom: var(--gap);
        border-radius: var(--radius);
        border: none;
        background: var(--grad);
        color: #fff;
        font: 700 22px var(--font);
        cursor: pointer;
        animation: pulse 1s ease-in-out infinite;
        --mdc-icon-size: 32px;
      }
      @keyframes pulse {
        50% {
          box-shadow: 0 0 0 6px rgba(255, 46, 151, 0.4), 0 0 30px var(--pk);
        }
      }
      .page.fill {
        display: flex;
        flex-direction: column;
        height: 100%;
        overflow: hidden;
      }
      .timers {
        flex: 1;
        min-height: 0;
        display: grid;
        gap: var(--gap);
      }
      .timer {
        container-type: size;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        min-height: 0;
        padding: 16px;
      }
      .ringwrap {
        position: relative;
        width: min(88cqw, 100cqh - 90px);
        aspect-ratio: 1;
        flex: none;
      }
      .ringsvg {
        width: 100%;
        height: 100%;
        transform: rotate(-90deg);
        display: block;
      }
      .track,
      .prog {
        fill: none;
        stroke-width: 10;
      }
      .track {
        stroke: rgba(127, 127, 127, 0.18);
      }
      .prog {
        stroke: var(--accent);
        stroke-linecap: round;
        transition: stroke-dashoffset 1s linear;
        filter: drop-shadow(0 0 6px var(--accent-soft));
      }
      .timer.soon .prog {
        stroke: var(--pk);
      }
      .inner {
        position: absolute;
        inset: 0;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
      }
      .left {
        font-size: clamp(30px, 19cqmin, 120px);
        font-weight: 600;
        line-height: 1;
        font-variant-numeric: tabular-nums;
      }
      .tname {
        font-size: clamp(13px, 5cqmin, 26px);
        margin-top: 0.4em;
        max-width: 70%;
        text-align: center;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .tbtns {
        display: flex;
        gap: 10px;
        margin-top: 14px;
        flex: none;
      }
      .none {
        grid-column: 1 / -1;
        display: flex;
        flex-direction: column;
        justify-content: center;
        text-align: center;
        padding: 40px 20px;
        font-size: 20px;
        font-weight: 600;
      }
      .none ha-icon {
        --mdc-icon-size: 48px;
        color: var(--accent);
        margin-bottom: 10px;
      }
      .none .muted {
        font-size: 15px;
        font-weight: 400;
        margin-top: 6px;
      }
      .start {
        margin-top: 18px;
        flex: none;
      }
      .quick {
        flex: none;
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
        gap: 12px;
      }
      .q {
        display: flex;
        flex-direction: column;
        align-items: center;
        padding: 12px 0;
        border-radius: var(--radius);
        border: 1px solid var(--line);
        background: var(--tile);
        box-shadow: var(--glow);
        color: var(--text);
        cursor: pointer;
        font-family: var(--font);
      }
      .q b {
        font-size: 28px;
      }
      .q span {
        font-size: 13px;
        color: var(--text-2);
      }
      .q:active {
        transform: scale(0.96);
      }
    `,
  ];
}

reg("panel-timers", PageTimers);
