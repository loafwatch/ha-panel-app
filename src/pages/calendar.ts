import { reg } from "../registry";
import { css, html, nothing } from "lit";
import { state } from "lit/decorators.js";
import { PageBase } from "./base";
import type { PanelConfig } from "../types";
import { isDone, type CalEvent } from "../data";
import { fmtTime, sameDay } from "../util";

const REPEATS: [string, string][] = [
  ["", "Doesn't repeat"],
  ["FREQ=DAILY", "Every day"],
  ["FREQ=WEEKLY", "Every week"],
  ["FREQ=WEEKLY;INTERVAL=2", "Every 2 weeks"],
  ["FREQ=MONTHLY", "Every month"],
  ["FREQ=YEARLY", "Every year"],
];

interface RemDraft {
  title: string;
  date: string;
  time: string;
  repeat: string;
  who: string;
}

const PALETTE = ["#ff2e97", "#00c8d4", "#a259ff", "#ffb020", "#3ddc84"];

export class PageCalendar extends PageBase {
  protected usesHub = true;
  @state() private month = startOfMonth(new Date());
  @state() private selected = new Date(new Date().setHours(0, 0, 0, 0));
  @state() private events: CalEvent[] = [];
  private loadedFor = "";
  /** When someone last tapped a day; an old pick (or "today" itself) follows the clock. */
  private pickedAt = 0;
  @state() private draft?: RemDraft;
  @state() private picked?: CalEvent;
  @state() private busy = false;

  protected watched() {
    return [...(this.config.calendars ?? []), ...(this.config.reminders ? [this.config.reminders.calendar] : [])];
  }

  private get remCal() {
    return this.config.reminders?.calendar;
  }

  /** Names offered under "For": Family plus each configured person's first name. */
  private people(): string[] {
    const ids = this.config.reminders?.people ?? [];
    return ids.map((id) => String(this.hass?.states[id]?.attributes.friendly_name ?? id.replace(/^person\./, "")).split(" ")[0]);
  }

  private newReminder() {
    const d = this.selected;
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const t = new Date(Date.now() + 3600_000);
    this.picked = undefined;
    this.draft = { title: "", date: iso, time: `${String(t.getHours()).padStart(2, "0")}:00`, repeat: "", who: "Family" };
  }

  private async saveReminder() {
    const d = this.draft;
    const cal = this.remCal;
    if (!d || !cal || !d.title.trim() || !d.date || !d.time) return;
    this.busy = true;
    try {
      const start = new Date(`${d.date}T${d.time}:00`);
      const end = new Date(start.getTime() + 15 * 60_000);
      const local = (x: Date) =>
        `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}T${String(x.getHours()).padStart(2, "0")}:${String(x.getMinutes()).padStart(2, "0")}:00`;
      const event: Record<string, string> = { summary: d.title.trim(), dtstart: local(start), dtend: local(end), description: `For: ${d.who}` };
      if (d.repeat) event.rrule = d.repeat;
      await this.hass!.callWS({ type: "calendar/event/create", entity_id: cal, event });
      this.toast(d.who === "Family" ? "Family reminder added" : `Reminder added for ${d.who} (phone only)`);
      this.draft = undefined;
      this.loadedFor = "";
      this.load();
      this.hub.refreshEvents();
    } catch (e: any) {
      this.toast(`Couldn't add the reminder: ${e?.message ?? e}`);
    } finally {
      this.busy = false;
    }
  }

  /** Find the stored event (uid, recurrence id) behind a reminder shown in the agenda. */
  private async stored(e: CalEvent): Promise<any | undefined> {
    const from = new Date(e.start.getTime() - 60_000).toISOString();
    const to = new Date(e.end.getTime() + 60_000).toISOString();
    const list: any[] = await (this.hass as any).callApi("GET", `calendars/${e.calendar}?start=${encodeURIComponent(from)}&end=${encodeURIComponent(to)}`);
    return list.find((x) => x.summary === e.summary && new Date(x.start.dateTime ?? x.start.date).getTime() === e.start.getTime());
  }

  private async markDone(e: CalEvent) {
    this.busy = true;
    try {
      const ev = await this.stored(e);
      if (!ev) throw new Error("not found");
      await this.hub.markReminderDone({
        summary: ev.summary,
        start: e.start,
        allDay: e.allDay,
        uid: ev.uid,
        recurrenceId: ev.recurrence_id ?? undefined,
        description: ev.description ?? "",
        rawStart: ev.start,
        rawEnd: ev.end,
        done: false,
      });
      this.toast(`Done: ${e.summary}`);
      this.picked = undefined;
      this.loadedFor = "";
      this.load();
    } catch (err: any) {
      this.toast(`Couldn't mark it done: ${err?.message ?? err}`);
    } finally {
      this.busy = false;
    }
  }

  private async deleteReminder(e: CalEvent, all: boolean) {
    this.busy = true;
    try {
      const ev = await this.stored(e);
      if (!ev) throw new Error("not found");
      const msg: Record<string, any> = { type: "calendar/event/delete", entity_id: e.calendar, uid: ev.uid };
      if (ev.recurrence_id) {
        msg.recurrence_id = ev.recurrence_id;
        if (all) msg.recurrence_range = "THISANDFUTURE";
      }
      await this.hass!.callWS(msg);
      this.toast(all && ev.recurrence_id ? "Reminder and future repeats deleted" : "Reminder deleted");
      this.picked = undefined;
      this.loadedFor = "";
      this.load();
      this.hub.refreshEvents();
    } catch (err: any) {
      this.toast(`Couldn't delete it: ${err?.message ?? err}`);
    } finally {
      this.busy = false;
    }
  }

  private sheet() {
    const p = this.picked;
    if (p) {
      return html`<div class="scrim" @click=${() => (this.picked = undefined)}>
        <div class="tile sheet" @click=${(e: Event) => e.stopPropagation()}>
          <div class="label"><ha-icon icon="mdi:bell-outline"></ha-icon>Reminder</div>
          <div class="ptitle">${p.summary}</div>
          <div class="muted">${p.start.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })} at ${fmtTime(p.start)}</div>
          <div class="row">
            ${isDone(p.description)
              ? html`<span class="donebadge"><ha-icon icon="mdi:check-circle"></ha-icon>Done</span>`
              : html`<button class="btn primary" ?disabled=${this.busy} @click=${() => this.markDone(p)}><ha-icon icon="mdi:check"></ha-icon> Mark as done</button>`}
            <button class="btn" ?disabled=${this.busy} @click=${() => this.deleteReminder(p, false)}>Delete this one</button>
            <button class="btn" ?disabled=${this.busy} @click=${() => this.deleteReminder(p, true)}>Delete this and future repeats</button>
            <span class="grow"></span>
            <button class="btn" @click=${() => (this.picked = undefined)}>Close</button>
          </div>
        </div>
      </div>`;
    }
    const d = this.draft;
    if (!d) return nothing;
    const set = (k: keyof RemDraft) => (e: Event) => (this.draft = { ...d, [k]: (e.target as HTMLInputElement).value });
    return html`<div class="scrim" @click=${() => (this.draft = undefined)}>
      <div class="tile sheet" @click=${(e: Event) => e.stopPropagation()}>
        <div class="label"><ha-icon icon="mdi:bell-plus-outline"></ha-icon>New reminder</div>
        <input class="field" placeholder="What's the reminder?" .value=${d.title} @input=${set("title")} />
        <div class="row">
          <input class="field" type="date" .value=${d.date} @input=${set("date")} />
          <input class="field" type="time" .value=${d.time} @input=${set("time")} />
        </div>
        <div class="sub">Repeat</div>
        <div class="chips">${REPEATS.map(([v, l]) => html`<button class="chip ${d.repeat === v ? "on" : ""}" @click=${() => (this.draft = { ...d, repeat: v })}>${l}</button>`)}</div>
        <div class="sub">For</div>
        <div class="chips">${["Family", ...this.people()].map(
          (w) => html`<button class="chip ${d.who === w ? "on" : ""}" @click=${() => (this.draft = { ...d, who: w })}>${w}</button>`
        )}</div>
        <div class="muted hint">${d.who === "Family" ? "Shows on the panel and goes to everyone's phone." : `Goes to ${d.who}'s phone only. It won't show on the panel.`}</div>
        <div class="row">
          <span class="grow"></span>
          <button class="btn" @click=${() => (this.draft = undefined)}>Cancel</button>
          <button class="btn primary" ?disabled=${this.busy || !d.title.trim()} @click=${() => this.saveReminder()}>Add reminder</button>
        </div>
      </div>
    </div>`;
  }

  /** Move back to today after midnight, or when returning to the page after a while. */
  private followToday() {
    const today = new Date(new Date().setHours(0, 0, 0, 0));
    if (sameDay(this.selected, today)) return;
    const stale = Date.now() - this.pickedAt > 10 * 60_000;
    if (!stale) return;
    this.selected = today;
    if (!sameDay(startOfMonth(today), this.month)) this.month = startOfMonth(today);
  }

  protected willUpdate(c: Map<string, unknown>) {
    super.willUpdate?.(c as any);
    this.followToday();
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
                  @click=${() => {
                    this.selected = d;
                    this.pickedAt = Date.now();
                  }}>
                  <span class="num">${d.getDate()}</span>
                  <span class="dots">${evs.slice(0, 4).map((e) => html`<i style="background:${this.color(e.calendar)}"></i>`)}</span>
                  <span class="mini">${evs.slice(0, 2).map((e) => html`<em>${e.summary}</em>`)}</span>
                </button>`;
              })}
            </div>
          </div>
          <div class="tile agenda">
            <div class="label ahead"><ha-icon icon="mdi:calendar-today"></ha-icon>
              <span class="grow">${this.selected.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}</span>
              ${this.remCal ? html`<button class="btn addrem" @click=${() => this.newReminder()}><ha-icon icon="mdi:bell-plus-outline"></ha-icon>Reminder</button>` : nothing}</div>
            ${dayEvents.length
              ? dayEvents.map(
                  (e) => html`<div class="ev ${e.calendar === this.remCal ? "rem" : ""} ${e.calendar === this.remCal && isDone(e.description) ? "done" : ""}" style="--c:${this.color(e.calendar)}"
                    @click=${() => e.calendar === this.remCal && ((this.draft = undefined), (this.picked = e))}>
                    <div class="when">${e.allDay ? "All day" : e.calendar === this.remCal ? fmtTime(e.start) : html`${fmtTime(e.start)}<br /><span class="muted">${fmtTime(e.end)}</span>`}</div>
                    <div class="what"><div class="sum">${e.calendar === this.remCal ? html`<ha-icon class="bell" icon="mdi:bell-outline"></ha-icon>` : nothing}${e.summary}</div>${e.location ? html`<div class="loc muted">${e.location}</div>` : nothing}</div>
                  </div>`
                )
              : html`<div class="empty">Nothing on this day</div>`}
          </div>
        </div>
        ${this.sheet()}
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
      .ahead {
        display: flex;
        align-items: center;
      }
      .grow {
        flex: 1;
      }
      .addrem {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 8px 14px;
        font-size: 14px;
        text-transform: none;
        letter-spacing: 0;
      }
      .addrem ha-icon {
        --mdc-icon-size: 18px;
      }
      .ev.rem {
        cursor: pointer;
      }
      .ev.done .sum {
        text-decoration: line-through;
        opacity: 0.55;
      }
      .donebadge {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        color: #3ddc84;
        font-weight: 600;
      }
      .bell {
        --mdc-icon-size: 16px;
        margin-right: 6px;
        vertical-align: -2px;
        color: var(--c);
      }
      .scrim {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.55);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 20;
      }
      .sheet {
        width: min(640px, 92vw);
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .ptitle {
        font-size: 22px;
        font-weight: 700;
      }
      .row {
        display: flex;
        gap: 10px;
        align-items: center;
        flex-wrap: wrap;
      }
      .row .field {
        flex: 1;
      }
      .field {
        font: 18px var(--font);
        padding: 12px 14px;
        border-radius: 12px;
        border: 1px solid var(--border, rgba(255, 255, 255, 0.15));
        background: var(--tile-2);
        color: var(--text);
        color-scheme: dark;
      }
      .sub {
        font-size: 13px;
        font-weight: 700;
        color: var(--text-2);
        text-transform: uppercase;
        letter-spacing: 0.06em;
      }
      .chips {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      .chip {
        font: 15px var(--font);
        padding: 9px 16px;
        border-radius: 999px;
        border: 1px solid var(--border, rgba(255, 255, 255, 0.18));
        background: var(--tile-2);
        color: var(--text);
        cursor: pointer;
      }
      .chip.on {
        background: var(--grad);
        border-color: transparent;
        color: #fff;
        font-weight: 600;
      }
      .hint {
        font-size: 14px;
      }
      .btn.primary {
        background: var(--grad);
        color: #fff;
        border-color: transparent;
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
  if (cal === config.reminders?.calendar) return "#3ddc84";
  const i = (config.calendars ?? []).indexOf(cal);
  return PALETTE[Math.max(0, i) % PALETTE.length];
}

reg("panel-calendar", PageCalendar);
