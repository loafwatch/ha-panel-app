import type { HomeAssistant, PanelConfig } from "./types";

export interface Forecast {
  datetime: string;
  condition?: string;
  temperature?: number;
  templow?: number;
  precipitation?: number;
  precipitation_probability?: number;
  wind_speed?: number;
}

export interface TodoItem {
  uid: string;
  summary: string;
  status: "needs_action" | "completed";
  due?: string;
}

export interface CalEvent {
  summary: string;
  start: Date;
  end: Date;
  allDay: boolean;
  location?: string;
  calendar: string;
  description?: string;
}

/** Who a reminder is for, read from its description ("For: Family" when unset). */
export function reminderFor(description?: string): string {
  const m = /^\s*For:\s*(.+?)\s*$/im.exec(description ?? "");
  return m ? m[1] : "Family";
}

/**
 * Shared live data that more than one page needs (forecasts, to-do lists,
 * calendar events). One subscription each, however many pages use it.
 */
export class DataHub extends EventTarget {
  daily: Forecast[] = [];
  hourly: Forecast[] = [];
  todos: Record<string, TodoItem[]> = {};
  events: CalEvent[] = [];
  maEntry?: string;

  private hass?: HomeAssistant;
  private config: PanelConfig = {};
  private unsubs: (() => void)[] = [];
  private calTimer?: number;
  private started = false;

  start(hass: HomeAssistant, config: PanelConfig) {
    this.hass = hass;
    this.config = config;
    if (this.started) return;
    this.started = true;
    const conn = hass.connection;

    if (config.weather) {
      for (const type of ["daily", "hourly"] as const) {
        conn
          .subscribeMessage<{ forecast: Forecast[] }>(
            (m) => {
              this[type] = m.forecast ?? [];
              this.changed();
            },
            { type: "weather/subscribe_forecast", entity_id: config.weather, forecast_type: type }
          )
          .then((u) => this.unsubs.push(u))
          .catch((e) => console.warn("ha-panel-app: forecast", e));
      }
    }

    for (const list of config.todo_lists ?? []) {
      conn
        .subscribeMessage<{ items: TodoItem[] }>(
          (m) => {
            this.todos[list.entity] = m.items ?? [];
            this.changed();
          },
          { type: "todo/item/subscribe", entity_id: list.entity }
        )
        .then((u) => this.unsubs.push(u))
        .catch((e) => console.warn("ha-panel-app: todo", e));
    }

    this.refreshEvents();
    this.calTimer = window.setInterval(() => this.refreshEvents(), 5 * 60 * 1000);
  }

  stop() {
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    window.clearInterval(this.calTimer);
    this.started = false;
  }

  update(hass: HomeAssistant) {
    this.hass = hass;
  }

  private changed() {
    this.dispatchEvent(new Event("change"));
  }

  /** Events from now (start of today) for `days` days. */
  async refreshEvents(days = 31) {
    const cals = [...(this.config.calendars ?? []), ...(this.config.reminders ? [this.config.reminders.calendar] : [])];
    if (!this.hass || !cals.length) return;
    this.events = await this.fetchEvents(new Date(new Date().setHours(0, 0, 0, 0)), days);
    this.changed();
    this.refreshSavings();
  }

  /** Upcoming energy saving sessions (from energy.octopus.saving_calendar), next 14 days. */
  savings: CalEvent[] = [];

  async refreshSavings() {
    const cal = this.config.energy?.octopus?.saving_calendar;
    if (!this.hass || !cal) return;
    this.savings = (await this.fetchEvents(new Date(new Date().setHours(0, 0, 0, 0)), 14, [cal])).filter((e) => e.end.getTime() > Date.now());
    this.changed();
  }

  async fetchEvents(from: Date, days: number, calendars?: string[]): Promise<CalEvent[]> {
    const rem = this.config.reminders?.calendar;
    const cals = calendars ?? [...(this.config.calendars ?? []), ...(rem && !(this.config.calendars ?? []).includes(rem) ? [rem] : [])];
    if (!this.hass || !cals.length) return [];
    const to = new Date(from.getTime() + days * 86400000);
    try {
      const r = await this.hass.callWS<{ response: Record<string, { events: any[] }> }>({
        type: "call_service",
        domain: "calendar",
        service: "get_events",
        service_data: { start_date_time: from.toISOString(), end_date_time: to.toISOString() },
        target: { entity_id: cals },
        return_response: true,
      });
      const out: CalEvent[] = [];
      for (const [cal, v] of Object.entries(r.response ?? {})) {
        for (const e of v.events ?? []) {
          const allDay = !String(e.start).includes("T");
          const start = allDay ? new Date(e.start + "T00:00:00") : new Date(e.start);
          const end = allDay ? new Date(e.end + "T00:00:00") : new Date(e.end);
          // personal reminders never show on the shared panel
          if (cal === rem && reminderFor(e.description).toLowerCase() !== "family") continue;
          out.push({ summary: tidyTitle(e.summary ?? ""), start, end, allDay, location: e.location, calendar: cal, description: e.description });
        }
      }
      return out.sort((a, b) => a.start.getTime() - b.start.getTime() || Number(b.allDay) - Number(a.allDay));
    } catch (e) {
      console.warn("ha-panel-app: calendar", e);
      return [];
    }
  }

  async musicEntry(): Promise<string | undefined> {
    if (this.maEntry || !this.hass) return this.maEntry;
    try {
      const entries = await this.hass.callWS<{ entry_id: string }[]>({ type: "config_entries/get", domain: "music_assistant" });
      this.maEntry = entries[0]?.entry_id;
    } catch {
      /* not installed */
    }
    return this.maEntry;
  }

  /** Call a service that returns data. */
  async respond<T = any>(domain: string, service: string, data: Record<string, any>, target?: Record<string, any>): Promise<T | undefined> {
    if (!this.hass) return undefined;
    try {
      const r = await this.hass.callWS<{ response: T }>({
        type: "call_service",
        domain,
        service,
        service_data: data,
        target,
        return_response: true,
      });
      return r.response;
    } catch (e) {
      console.warn(`ha-panel-app: ${domain}.${service}`, e);
      return undefined;
    }
  }
}

/** Tidy hand-typed titles: "Party- Sam" or "Party -Sam" becomes "Party - Sam". Hyphenated words are left alone. */
export function tidyTitle(t: string) {
  return t.replace(/(\S) ?- (?=\S)/g, "$1 - ").replace(/(\S) -(?=\S)/g, "$1 - ").trim();
}
