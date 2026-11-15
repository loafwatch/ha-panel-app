import { reg } from "../registry";
import { css, html, nothing } from "lit";
import { PageBase } from "./base";
import { WEATHER_ICON, weatherLabel } from "../util";
import "../components/weather-fx";

export class PageWeather extends PageBase {
  protected usesHub = true;

  protected watched() {
    return [this.config.weather].filter(Boolean) as string[];
  }

  render() {
    const w = this.st(this.config.weather);
    if (!w) return html`<div class="page"><div class="empty">No weather entity configured.</div></div>`;
    const a = w.attributes;
    const daily = this.hub.daily.slice(0, 7);
    const hourly = this.hub.hourly.slice(0, 24);
    return html`
      <div class="page">
        <div class="top">
          <div class="tile now">
            <panel-weather-fx condition=${w.state} ?dark=${this.dark}></panel-weather-fx>
            <div class="nowrow">
              <ha-icon icon=${WEATHER_ICON[w.state] ?? "mdi:weather-cloudy"}></ha-icon>
              <div>
                <div class="t">${Math.round(a.temperature)}°</div>
                <div class="c">${weatherLabel(w.state)}</div>
              </div>
            </div>
            <div class="facts">
              ${a.apparent_temperature != null ? html`<span>Feels like ${Math.round(a.apparent_temperature)}°</span>` : nothing}
              ${a.humidity != null ? html`<span><ha-icon icon="mdi:water-percent"></ha-icon>${Math.round(a.humidity)}%</span>` : nothing}
              ${a.wind_speed != null ? html`<span><ha-icon icon="mdi:weather-windy"></ha-icon>${Math.round(a.wind_speed)} ${a.wind_speed_unit ?? ""}</span>` : nothing}
              ${a.pressure != null ? html`<span><ha-icon icon="mdi:gauge"></ha-icon>${Math.round(a.pressure)} ${a.pressure_unit ?? ""}</span>` : nothing}
            </div>
          </div>
          <div class="tile days">
            <div class="label"><ha-icon icon="mdi:calendar-week"></ha-icon>Coming days</div>
            <div class="day head">
              <span></span><span></span><span class="rain">Rain</span><span class="num">High</span><span class="num">Low</span>
            </div>
            ${daily.map((d, i) => {
              const t = new Date(d.datetime);
              const cond = d.condition ?? "";
              const pp = d.precipitation_probability;
              const mm = d.precipitation ?? 0;
              const rain = pp != null ? (pp >= 5 ? `${Math.round(pp)}%` : "") : mm >= 0.1 ? `${mm < 10 ? mm.toFixed(1) : Math.round(mm)} mm` : "";
              return html`<div class="day">
                <span class="dn">${i === 0 ? "Today" : t.toLocaleDateString("en-GB", { weekday: "long" })}</span>
                <span class="cond"><ha-icon icon=${WEATHER_ICON[cond] ?? "mdi:weather-cloudy"}></ha-icon>${weatherLabel(cond)}</span>
                <span class="rain ${rain ? "" : "dry"}">${rain ? html`<ha-icon icon="mdi:water"></ha-icon>${rain}` : "Dry"}</span>
                <span class="num hi">${d.temperature != null ? `${Math.round(d.temperature)}°` : ""}</span>
                <span class="num lo">${d.templow != null ? `${Math.round(d.templow)}°` : ""}</span>
              </div>`;
            })}
          </div>
        </div>
        <div class="tile hours">
          <div class="label"><ha-icon icon="mdi:clock-outline"></ha-icon>Next 24 hours</div>
          <div class="hrow">
            ${hourly.map((h) => {
              const t = new Date(h.datetime);
              return html`<div class="hr">
                <span class="muted">${t.toLocaleTimeString("en-GB", { hour: "2-digit" })}</span>
                <ha-icon icon=${WEATHER_ICON[h.condition ?? ""] ?? "mdi:weather-cloudy"}></ha-icon>
                <b>${Math.round(h.temperature ?? 0)}°</b>
                ${h.precipitation ? html`<span class="mm">${h.precipitation}mm</span>` : html`<span class="mm"></span>`}
              </div>`;
            })}
          </div>
        </div>
      </div>
    `;
  }

  static styles = [
    PageBase.styles,
    css`
      .top {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
        gap: var(--gap);
        margin-bottom: var(--gap);
      }
      @container (max-width: 900px) {
        .top {
          grid-template-columns: 1fr;
        }
      }
      .now {
        min-height: 300px;
        display: flex;
        flex-direction: column;
        justify-content: space-between;
      }
      .nowrow {
        display: flex;
        align-items: center;
        gap: 22px;
        position: relative;
        z-index: 1;
      }
      .nowrow ha-icon {
        --mdc-icon-size: 110px;
        color: var(--accent);
      }
      .t {
        font-size: 84px;
        font-weight: 300;
        line-height: 1;
      }
      .c {
        font-size: 22px;
        color: var(--text-2);
        margin-top: 6px;
      }
      .facts {
        display: flex;
        flex-wrap: wrap;
        gap: 10px 22px;
        font-size: 15px;
        color: var(--text-2);
        position: relative;
        z-index: 1;
      }
      .facts span {
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      .facts ha-icon {
        --mdc-icon-size: 18px;
      }
      .day {
        display: grid;
        grid-template-columns: minmax(64px, 0.9fr) minmax(0, 1.4fr) 74px 38px 38px;
        align-items: center;
        gap: 8px;
        padding: 9px 0;
        font-size: 16px;
        border-top: 1px solid rgba(127, 127, 127, 0.12);
      }
      .day.head {
        border-top: 0;
        padding: 0 0 4px;
        font-size: 12px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--text-2);
      }
      .dn {
        font-weight: 600;
      }
      .cond {
        display: flex;
        align-items: center;
        gap: 8px;
        color: var(--text-2);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .cond ha-icon {
        color: var(--accent);
        flex: none;
      }
      .rain {
        display: flex;
        align-items: center;
        gap: 3px;
        color: var(--cy);
        font-weight: 600;
        font-size: 15px;
      }
      .head .rain {
        color: var(--text-2);
        font-size: 12px;
      }
      :host(:not([dark])) .day:not(.head) .rain {
        color: #0089a0;
      }
      .rain ha-icon {
        --mdc-icon-size: 16px;
      }
      .rain.dry {
        color: var(--text-2) !important;
        font-weight: 400;
      }
      .num {
        text-align: right;
      }
      .hi {
        font-weight: 600;
      }
      .lo {
        color: var(--text-2);
      }
      .hrow {
        display: flex;
        gap: 6px;
        overflow-x: auto;
        padding-bottom: 6px;
        scrollbar-width: thin;
      }
      .hr {
        flex: 0 0 64px;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 6px;
        padding: 10px 0;
        border-radius: var(--radius-sm);
        background: var(--tile-2);
        font-size: 14px;
      }
      .hr ha-icon {
        color: var(--accent);
      }
      .mm {
        font-size: 11px;
        color: var(--cy);
        min-height: 13px;
      }
    `,
  ];
}

reg("panel-weather", PageWeather);
