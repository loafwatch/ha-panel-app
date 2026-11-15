import { css, html, nothing } from "lit";
import { PageBase } from "./base";
import { WEATHER_ICON, weatherLabel } from "../util";

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
    const lo = Math.min(...daily.map((d) => d.templow ?? d.temperature ?? 0));
    const hi = Math.max(...daily.map((d) => d.temperature ?? 0));
    const fx = fxFor(w.state);
    return html`
      <div class="page">
        <div class="top">
          <div class="tile now ${fx}">
            <div class="fx"></div>
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
            ${daily.map((d, i) => {
              const t = new Date(d.datetime);
              const l = d.templow ?? lo;
              const h = d.temperature ?? hi;
              const left = hi > lo ? ((l - lo) / (hi - lo)) * 100 : 0;
              const width = hi > lo ? ((h - l) / (hi - lo)) * 100 : 100;
              return html`<div class="day">
                <span class="dn">${i === 0 ? "Today" : t.toLocaleDateString("en-GB", { weekday: "short" })}</span>
                <ha-icon icon=${WEATHER_ICON[d.condition ?? ""] ?? "mdi:weather-cloudy"}></ha-icon>
                <span class="rain">${d.precipitation_probability != null ? `${Math.round(d.precipitation_probability)}%` : d.precipitation ? `${d.precipitation}mm` : ""}</span>
                <span class="lo">${Math.round(l)}°</span>
                <span class="range"><i style="left:${left}%;width:${Math.max(width, 4)}%"></i></span>
                <span class="hi">${Math.round(h)}°</span>
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
      @media (max-width: 900px) {
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
        grid-template-columns: 64px 34px 44px 36px 1fr 36px;
        align-items: center;
        gap: 8px;
        padding: 9px 0;
        font-size: 15px;
      }
      .dn {
        font-weight: 600;
      }
      .day ha-icon {
        color: var(--accent);
      }
      .rain {
        font-size: 12px;
        color: var(--cy);
        font-weight: 600;
      }
      .lo {
        color: var(--text-2);
        text-align: right;
      }
      .hi {
        font-weight: 600;
      }
      .range {
        position: relative;
        height: 6px;
        border-radius: 3px;
        background: rgba(127, 127, 127, 0.2);
      }
      .range i {
        position: absolute;
        top: 0;
        bottom: 0;
        border-radius: 3px;
        background: linear-gradient(90deg, var(--cy), var(--pk));
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
      /* gentle weather animations behind the current conditions */
      .fx {
        position: absolute;
        inset: 0;
        pointer-events: none;
        opacity: 0.5;
      }
      .fx-rain .fx {
        background-image: repeating-linear-gradient(105deg, transparent 0 14px, rgba(0, 200, 212, 0.35) 14px 15px);
        background-size: 60px 60px;
        animation: rainfall 0.8s linear infinite;
      }
      @keyframes rainfall {
        to {
          background-position: -16px 60px;
        }
      }
      .fx-sun .fx {
        background: radial-gradient(circle at 85% 15%, rgba(255, 190, 60, 0.45), transparent 45%);
        animation: glow 6s ease-in-out infinite;
      }
      @keyframes glow {
        50% {
          opacity: 0.25;
        }
      }
      .fx-cloud .fx,
      .fx-fog .fx {
        background: radial-gradient(ellipse at 20% 30%, rgba(160, 150, 180, 0.35), transparent 50%),
          radial-gradient(ellipse at 70% 60%, rgba(160, 150, 180, 0.3), transparent 50%);
        background-size: 200% 100%;
        animation: drift 30s linear infinite;
      }
      @keyframes drift {
        to {
          background-position: 200% 0;
        }
      }
      .fx-snow .fx {
        background-image: radial-gradient(circle, rgba(255, 255, 255, 0.8) 1.5px, transparent 2px);
        background-size: 34px 34px;
        animation: snowfall 6s linear infinite;
      }
      @keyframes snowfall {
        to {
          background-position: 20px 340px;
        }
      }
    `,
  ];
}

function fxFor(c: string) {
  if (/rain|pouring|lightning/.test(c)) return "fx-rain";
  if (/snow/.test(c)) return "fx-snow";
  if (c === "sunny") return "fx-sun";
  if (c === "fog") return "fx-fog";
  if (/cloud/.test(c)) return "fx-cloud";
  return "";
}

customElements.get("panel-weather") || customElements.define("panel-weather", PageWeather);
