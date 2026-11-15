import { reg } from "../registry";
import { css, html, nothing } from "lit";
import { state } from "lit/decorators.js";
import { PageBase } from "./base";
import type { PanelConfig } from "../types";
import type { CalEvent } from "../data";
import { fmtTime, sameDay } from "../util";

const PALETTE = ["#ff2e97", "#00c8d4", "#a259ff", "#ffb020", "#3ddc84"];

export class PageCalendar extends PageBase {
  protected usesHub = true;
  @state() private month = startOfMonth(new Date());
  @state() private selected = new Date(new Date().setHours(0, 0, 0, 0));
  @state() private events: CalEvent[] = [];
  private loadedFor = "";

  protected watched() {
    return this.config.calendars ?? [];
  }

  protected updated(c: Map<string, unknown>) {
    super.updated(c as any);
    const key = this.month.toISOString();
    if (this.active && this.loadedFor !== key) {
      this.loadedFor = key;
      this.load();
    }
  }

  private async load() {
    const from = new Date(this.month);
    from.setDate(from.getDate() - ((from.getDay() + 6) % 7)); // back to Monday
    this.events = await this.hub.fetchEvents(from, 42);
  }

  private color(cal: string) {
    return calColor(this.config, cal);
  }

  private eventsOn(d: Date) {
    const s = d.getTime();
    const e = s + 86400000;
    return this.events.filter((x) => x.start.getTime() < e && x.end.getTime() > s);
  }

  private shift(n: number) {
    const m = new Date(this.month);
    m.setMonth(m.getMonth() + n);
    this.month = m;
  }

  render() {
    const first = new Date(this.month);
    first.setDate(first.getDate() - ((first.getDay() + 6) % 7));
    const days = Array.from({ length: 42 }, (_, i) => new Date(first.getFullYear(), first.getMonth(), first.getDate() + i));
    const today = new Date();
    const dayEvents = this.eventsOn(this.selected);
    return html`
      <div class="page">
        <div class="layout">
          <div class="tile month">
            <div class="mhead">
              <button class="btn icon" aria-label="Previous month" @click=${() => this.shift(-1)}><ha-icon icon="mdi:chevron-left"></ha-icon></button>
              <div class="mtitle">${this.month.toLocaleDateString("en-GB", { month: "long", year: "numeric" })}</div>
              <button class="btn icon" aria-label="Next month" @click=${() => this.shift(1)}><ha-icon icon="mdi:chevron-right"></ha-icon></button>
              <button class="btn todaybtn" @click=${() => {
                this.month = startOfMonth(new Date());
                this.selected = new Date(new Date().setHours(0, 0, 0, 0));
              }}>Today</button>
            </div>
            <div class="dow">${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => html`<span>${d}</span>`)}</div>
            <div class="cells">
              ${days.map((d) => {
                const evs = this.eventsOn(d);
                const other = d.getMonth() !== this.month.getMonth();
                return html`<button class="cell ${other ? "other" : ""} ${sameDay(d, today) ? "today" : ""} ${sameDay(d, this.selected) ? "sel" : ""}"
                  @click=${() => (this.selected = d)}>
                  <span class="num">${d.getDate()}</span>
                  <span class="dots">${evs.slice(0, 4).map((e) => html`<i style="background:${this.color(e.calendar)}"></i>`)}</span>
                  <span class="mini">${evs.slice(0, 2).map((e) => html`<em>${e.summary}</em>`)}</span>
                </button>`;
              })}
            </div>
          </div>
          <div class="tile agenda">
            <div class="label"><ha-icon icon="mdi:calendar-today"></ha-icon>
              ${this.selected.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}</div>
            ${dayEvents.length
              ? dayEvents.map(
                  (e) => html`<div class="ev" style="--c:${this.color(e.calendar)}">
                    <div class="when">${e.allDay ? "All day" : html`${fmtTime(e.start)}<br /><span class="muted">${fmtTime(e.end)}</span>`}</div>
                    <div class="what"><div class="sum">${e.summary}</div>${e.location ? html`<div class="loc muted">${e.location}</div>` : nothing}</div>
                  </div>`
                )
              : html`<div class="empty">Nothing on this day</div>`}
          </div>
        </div>
      </div>
    `;
  }

  static styles = [
    PageBase.styles,
    css`
      .layout {
        display: grid;
        grid-template-columns: minmax(0, 2fr) minmax(280px, 1fr);
        gap: var(--gap);
        align-items: start;
      }
      @container (max-width: 900px) {
        .layout {
          grid-template-columns: 1fr;
        }
      }
      .mhead {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-bottom: 14px;
      }
      .mtitle {
        font-size: 22px;
        font-weight: 700;
        flex: 1;
        text-align: center;
      }
      .btn.icon {
        padding: 8px;
      }
      .todaybtn {
        padding: 8px 14px;
      }
      .dow {
        display: grid;
        grid-template-columns: repeat(7, 1fr);
        font-size: 12px;
        font-weight: 700;
        color: var(--text-2);
        text-align: center;
        margin-bottom: 6px;
      }
      .cells {
        display: grid;
        grid-template-columns: repeat(7, minmax(0, 1fr));
        gap: 6px;
      }
      .cell {
        min-height: 78px;
        border-radius: 12px;
        border: 1px solid transparent;
        background: var(--tile-2);
        color: var(--text);
        padding: 6px 7px;
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 3px;
        cursor: pointer;
        text-align: left;
        font: 14px var(--font);
        overflow: hidden;
      }
      .cell.other {
        opacity: 0.4;
      }
      .cell.today .num {
        background: var(--grad);
        color: #fff;
        border-radius: 999px;
        padding: 0 7px;
      }
      .cell.sel {
        border-color: var(--accent);
        box-shadow: 0 0 10px var(--accent-soft);
      }
      .num {
        font-weight: 700;
      }
      .dots {
        display: none;
        gap: 3px;
      }
      .dots i {
        width: 6px;
        height: 6px;
        border-radius: 50%;
      }
      .mini {
        display: flex;
        flex-direction: column;
        gap: 2px;
        width: 100%;
      }
      .mini em {
        font-style: normal;
        font-size: 11px;
        line-height: 1.25;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        color: var(--text-2);
      }
      @container (max-width: 700px) {
        .mini {
          display: none;
        }
        .dots {
          display: flex;
        }
        .cell {
          min-height: 54px;
        }
      }
      .ev {
        display: flex;
        gap: 14px;
        padding: 12px 0 12px 12px;
        border-left: 4px solid var(--c);
        margin-bottom: 10px;
        border-radius: 4px;
      }
      .when {
        flex: 0 0 56px;
        font-size: 14px;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
        line-height: 1.4;
      }
      .sum {
        font-size: 16px;
        font-weight: 600;
        line-height: 1.35;
      }
      .loc {
        font-size: 13px;
        margin-top: 3px;
        line-height: 1.4;
      }
    `,
  ];
}

function startOfMonth(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

/** Stable accent colour for a calendar, by its position in the config. */
export function calColor(config: PanelConfig, cal: string) {
  const i = (config.calendars ?? []).indexOf(cal);
  return PALETTE[Math.max(0, i) % PALETTE.length];
}

reg("panel-calendar", PageCalendar);
