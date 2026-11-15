import { reg } from "../registry";
import { css, html, nothing } from "lit";
import { state } from "lit/decorators.js";
import { PageBase } from "./base";

type Range = "day" | "week" | "month" | "year";
/** "electricity", "gas" or "dev:<index into energy.devices>" */
type Kind = string;
interface Bar {
  t: number;
  kwh: number;
  cost?: number;
  future: boolean;
}
interface Source {
  energy: string;
  cost?: string;
}

const RANGES: { id: Range; label: string }[] = [
  { id: "day", label: "Day" },
  { id: "week", label: "Week" },
  { id: "month", label: "Month" },
  { id: "year", label: "Year" },
];

export class PageEnergy extends PageBase {
  @state() private range: Range = "week";
  @state() private kind: Kind = "electricity";
  @state() private bars: Bar[] = [];
  @state() private sel?: number;
  @state() private sources: Partial<Record<Kind, Source>> = {};
  /** Electricity kWh per slot while a device is selected, for its share of the total. */
  @state() private elec: number[] = [];
  private loadedKey = "";
  private loadedAt = 0;
  private prefsLoaded = false;

  protected watched() {
    const e = this.config.energy;
    return [e?.power, e?.rate, ...(e?.costs ?? []).map((c) => c.entity), ...(e?.devices ?? []).map((d) => d.power)].filter(Boolean) as string[];
  }

  protected updated(c: Map<string, unknown>) {
    super.updated(c as any);
    if (!this.active) return;
    if (!this.prefsLoaded) {
      this.prefsLoaded = true;
      this.loadPrefs();
      return;
    }
    const key = this.range + "|" + this.kind;
    if (key !== this.loadedKey || Date.now() - this.loadedAt > 5 * 60 * 1000) this.load();
  }

  /** Meters come from Home Assistant's own Energy dashboard settings. */
  private async loadPrefs() {
    try {
      const p = await this.hass.callWS<{ energy_sources: any[] }>({ type: "energy/get_prefs" });
      const src: Partial<Record<Kind, Source>> = {};
      for (const s of p.energy_sources ?? []) {
        if (s.type === "grid" && s.stat_energy_from && !src.electricity) src.electricity = { energy: s.stat_energy_from, cost: s.stat_cost ?? undefined };
        if (s.type === "gas" && s.stat_energy_from && !src.gas) src.gas = { energy: s.stat_energy_from, cost: s.stat_cost ?? undefined };
      }
      this.sources = src;
      if (!src[this.kind]) this.kind = src.electricity ? "electricity" : "gas";
    } catch (e) {
      console.warn("ha-panel-app: energy prefs", e);
    }
    this.requestUpdate();
  }

  private slots(): { start: Date; starts: number[]; period: "hour" | "day" | "month" } {
    const now = new Date();
    const mid = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const days = (n: number) => {
      const out: number[] = [];
      for (let i = n - 1; i >= 0; i--) out.push(new Date(mid.getFullYear(), mid.getMonth(), mid.getDate() - i).getTime());
      return out;
    };
    switch (this.range) {
      case "day": {
        const out: number[] = [];
        for (let h = 0; h < 24; h++) out.push(new Date(mid.getFullYear(), mid.getMonth(), mid.getDate(), h).getTime());
        return { start: mid, starts: out, period: "hour" };
      }
      case "week":
        return { start: new Date(days(7)[0]), starts: days(7), period: "day" };
      case "month":
        return { start: new Date(days(30)[0]), starts: days(30), period: "day" };
      case "year": {
        const out: number[] = [];
        for (let i = 11; i >= 0; i--) out.push(new Date(now.getFullYear(), now.getMonth() - i, 1).getTime());
        return { start: new Date(out[0]), starts: out, period: "month" };
      }
    }
  }

  private source(kind: Kind): Source | undefined {
    const m = kind.match(/^dev:(\d+)$/);
    if (m) {
      const d = this.config.energy?.devices?.[+m[1]];
      return d?.energy ? { energy: d.energy } : undefined;
    }
    return this.sources[kind];
  }

  private async load() {
    const src = this.source(this.kind);
    const key = this.range + "|" + this.kind;
    this.loadedKey = key;
    this.loadedAt = Date.now();
    if (!src) return;
    const { start, starts, period } = this.slots();
    const isDev = this.kind.startsWith("dev:");
    const elecId = isDev ? this.sources.electricity?.energy : undefined;
    const ids = [src.energy, src.cost, elecId].filter(Boolean) as string[];
    try {
      const r = await this.hass.callWS<Record<string, { start: number | string; change?: number | null }[]>>({
        type: "recorder/statistics_during_period",
        start_time: start.toISOString(),
        statistic_ids: ids,
        period,
        types: ["change"],
      });
      if (key !== this.range + "|" + this.kind) return; // user moved on
      const pick = (id?: string) => {
        const m = new Map<number, number>();
        if (!id) return m;
        for (const row of r[id] ?? []) {
          const t = typeof row.start === "number" ? row.start : Date.parse(row.start);
          // file each row under the slot it starts in
          let k = -1;
          for (let i = 0; i < starts.length && starts[i] <= t + 60_000; i++) k = i;
          if (k >= 0) m.set(k, (m.get(k) ?? 0) + (row.change ?? 0));
        }
        return m;
      };
      const kwh = pick(src.energy);
      const cost = src.cost ? pick(src.cost) : undefined;
      const now = Date.now();
      this.bars = starts.map((t, i) => ({ t, kwh: Math.max(0, kwh.get(i) ?? 0), cost: cost?.get(i), future: t > now }));
      const el = elecId ? pick(elecId) : undefined;
      this.elec = el ? starts.map((_, i) => Math.max(0, el.get(i) ?? 0)) : [];
      this.sel = undefined;
    } catch (e) {
      console.warn("ha-panel-app: energy statistics", e);
    }
  }

  render() {
    const en = this.config.energy;
    if (!en) return html`<div class="page"><div class="empty">Energy isn't configured.</div></div>`;
    const w = Number(this.st(en.power)?.state) || 0;
    const rate = this.st(en.rate);
    const costs = (en.costs ?? []).map((c) => ({ name: c.name, icon: c.icon, v: Number(this.st(c.entity)?.state) || 0 }));
    const total = costs.reduce((s, c) => s + c.v, 0);
    const perHour = rate ? (w / 1000) * Number(rate.state) : 0;
    return html`
      <div class="page">
        <div class="cards">
          <div class="tile hero">
            <div class="label"><ha-icon icon="mdi:flash"></ha-icon>Using now</div>
            <div class="huge">${w >= 1000 ? (w / 1000).toFixed(2) : Math.round(w)}<span>${w >= 1000 ? "kW" : "W"}</span></div>
            ${rate ? html`<div class="muted">About £${perHour.toFixed(2)} an hour at ${(Number(rate.state) * 100).toFixed(1)}p/kWh</div>` : nothing}
          </div>
          ${costs.length
            ? html`<div class="tile">
                <div class="label"><ha-icon icon="mdi:cash"></ha-icon>Today so far</div>
                <div class="huge">£${total.toFixed(2)}</div>
                <div class="split">
                  ${costs.map((c) => html`<div><ha-icon icon=${c.icon ?? "mdi:currency-gbp"}></ha-icon>${c.name}<b>£${c.v.toFixed(2)}</b></div>`)}
                </div>
              </div>`
            : nothing}
        </div>
        ${en.devices?.length
          ? html`<div class="tile apps">
              <div class="label"><ha-icon icon="mdi:power-plug-outline"></ha-icon>Appliances</div>
              <div class="applist">
                ${en.devices.map((d) => {
                  const dw = Number(this.st(d.power)?.state);
                  const today = Number(this.st(d.energy)?.state);
                  const on = dw >= 5;
                  return html`<div class="app ${on ? "on" : ""}">
                    <ha-icon icon=${d.icon ?? "mdi:power-plug-outline"}></ha-icon>
                    <span class="an">${d.name}</span>
                    <b>${isNaN(dw) ? "–" : on ? (dw >= 1000 ? (dw / 1000).toFixed(2) + " kW" : Math.round(dw) + " W") : "off"}</b>
                    <span class="muted">${isNaN(today) ? "" : `${today.toFixed(2)} kWh today`}</span>
                  </div>`;
                })}
              </div>
            </div>`
          : nothing}
        <div class="tile chart">
          <div class="chead">
            <div class="seg">
              ${(["electricity", "gas"] as Kind[])
                .filter((k) => this.sources[k])
                .map(
                  (k) => html`<button class="chip ${this.kind === k ? "on" : ""}" @click=${() => (this.kind = k)}>
                    <ha-icon icon=${k === "gas" ? "mdi:fire" : "mdi:flash"}></ha-icon>${k === "gas" ? "Gas" : "Electricity"}
                  </button>`,
                )}
              ${(en.devices ?? []).map((d, i) =>
                d.energy
                  ? html`<button class="chip ${this.kind === "dev:" + i ? "on" : ""}" @click=${() => (this.kind = "dev:" + i)}>
                      <ha-icon icon=${d.icon ?? "mdi:power-plug-outline"}></ha-icon>${d.name}
                    </button>`
                  : nothing,
              )}
            </div>
            <div class="seg">
              ${RANGES.map((r) => html`<button class="chip ${this.range === r.id ? "on" : ""}" @click=${() => (this.range = r.id)}>${r.label}</button>`)}
            </div>
          </div>
          ${this.chart()}
        </div>
      </div>
    `;
  }

  private chart() {
    if (!this.sources.electricity && !this.sources.gas)
      return html`<div class="empty">Add your meters in Home Assistant's Energy settings to see usage here.</div>`;
    const bars = this.bars;
    if (!bars.length) return html`<div class="empty">Loading…</div>`;
    const past = bars.filter((b) => !b.future);
    const total = past.reduce((s, b) => s + b.kwh, 0);
    const hasCost = past.some((b) => b.cost != null);
    const totalCost = past.reduce((s, b) => s + (b.cost ?? 0), 0);
    const max = Math.max(...bars.map((b) => b.kwh), 0.001);
    const sel = this.sel != null ? bars[this.sel] : undefined;
    // average over complete slots only (the current hour/day/month is still filling up)
    const withData = past.slice(0, -1).filter((b) => b.kwh > 0);
    const avg = withData.length ? withData.reduce((s, b) => s + b.kwh, 0) / withData.length : 0;
    const unitWord = this.range === "day" ? "an hour" : this.range === "year" ? "a month" : "a day";
    const isDev = this.kind.startsWith("dev:");
    const elecTotal = isDev ? this.elec.filter((_, i) => !bars[i]?.future).reduce((s, v) => s + v, 0) : 0;
    const share = isDev && elecTotal > 0 ? Math.round((total / elecTotal) * 100) : undefined;
    const devName = isDev ? this.config.energy?.devices?.[+this.kind.slice(4)]?.name : undefined;
    return html`
      <div class="sum">
        ${sel
          ? html`<div class="big">${fmtKwh(sel.kwh)}${sel.cost != null ? html`<span class="cost">£${sel.cost.toFixed(2)}</span>` : nothing}</div>
              <div class="muted">${this.slotLabel(sel.t, true)}</div>`
          : html`<div class="big">${fmtKwh(total)}${hasCost ? html`<span class="cost">£${totalCost.toFixed(2)}</span>` : nothing}${share != null ? html`<span class="cost">${share}% of electricity</span>` : nothing}</div>
              <div class="muted">${devName ? `${devName} · ` : ""}${this.rangeLabel()} · average ${fmtKwh(avg)} ${unitWord}</div>`}
      </div>
      <div class="bars ${isDev ? "device" : this.kind}" @click=${(e: Event) => e.target === e.currentTarget && (this.sel = undefined)}>
        ${[0.25, 0.5, 0.75].map((f) => html`<i class="gl" style="bottom:${f * 100}%"></i>`)}
        ${bars.map(
          (b, i) => html`<button
            class="bar ${b.future ? "future" : ""} ${this.sel === i ? "sel" : ""} ${this.sel != null && this.sel !== i ? "dim" : ""}"
            ?disabled=${b.future}
            @click=${() => (this.sel = this.sel === i ? undefined : i)}
            aria-label=${this.slotLabel(b.t, true) + " " + fmtKwh(b.kwh)}
          >
            <span style="height:${b.future ? 0 : Math.max(b.kwh > 0 ? 2 : 0, (b.kwh / max) * 100)}%"></span>
          </button>`,
        )}
      </div>
      <div class="axis muted">${bars.map((b, i) => html`<span>${this.tickLabel(b.t, i)}</span>`)}</div>
    `;
  }

  private tickLabel(t: number, i: number) {
    const d = new Date(t);
    switch (this.range) {
      case "day":
        return i % 3 === 0 ? String(d.getHours()).padStart(2, "0") : "";
      case "week":
        return d.toLocaleDateString("en-GB", { weekday: "short" });
      case "month":
        return i % 5 === 0 || i === 29 ? String(d.getDate()) : "";
      case "year":
        return d.toLocaleDateString("en-GB", { month: "short" }).slice(0, 1);
    }
  }

  private slotLabel(t: number, long = false) {
    const d = new Date(t);
    switch (this.range) {
      case "day": {
        const e = new Date(t + 3600_000);
        const hm = (x: Date) => x.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
        return `${hm(d)}–${hm(e)}`;
      }
      case "year":
        return d.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
      default:
        return d.toLocaleDateString("en-GB", { weekday: long ? "long" : "short", day: "numeric", month: "long" });
    }
  }

  private rangeLabel() {
    return { day: "Today", week: "Last 7 days", month: "Last 30 days", year: "Last 12 months" }[this.range];
  }

  static styles = [
    PageBase.styles,
    css`
      .cards {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
        gap: var(--gap);
        margin-bottom: var(--gap);
      }
      .huge {
        font-size: 64px;
        font-weight: 300;
        line-height: 1.05;
      }
      .huge span {
        font-size: 24px;
        margin-left: 6px;
        color: var(--text-2);
      }
      .hero .muted {
        margin-top: 8px;
      }
      .split {
        display: flex;
        flex-wrap: wrap;
        gap: 10px 24px;
        margin-top: 10px;
        font-size: 15px;
        color: var(--text-2);
      }
      .split div {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .split b {
        color: var(--text);
        margin-left: 4px;
      }
      .chead {
        display: flex;
        align-items: center;
        justify-content: space-between;
      }
      .seg {
        display: flex;
        gap: 8px;
      }
      .apps {
        grid-column: 1 / -1;
      }
      .applist {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(240px, 320px));
        gap: 10px 32px;
        margin-top: 6px;
      }
      .app {
        display: grid;
        grid-template-columns: auto 1fr auto;
        grid-template-rows: auto auto;
        column-gap: 10px;
        align-items: center;
        font-size: 16px;
      }
      .app ha-icon {
        grid-row: 1 / 3;
        color: var(--text-2);
      }
      .app.on ha-icon {
        color: var(--cy);
      }
      .app b {
        font-size: 18px;
      }
      .app .muted {
        grid-column: 2 / 4;
        font-size: 13px;
      }
      .chead {
        flex-wrap: wrap;
        gap: 10px;
      }
      .seg .chip {
        padding: 8px 16px;
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      .seg .chip ha-icon {
        --mdc-icon-size: 18px;
      }
      .sum {
        margin: 16px 0 10px;
        min-height: 62px;
      }
      .big {
        font-size: 34px;
        font-weight: 400;
        display: flex;
        align-items: baseline;
        gap: 14px;
      }
      .cost {
        font-size: 20px;
        color: var(--text-2);
      }
      .bars {
        --c1: #ff2e97;
        --c2: #7a1bd1;
        position: relative;
        display: flex;
        align-items: flex-end;
        gap: 4px;
        height: 230px;
        border-bottom: 1px solid rgba(127, 127, 127, 0.25);
      }
      .bars.gas {
        --c1: #00c8d4;
        --c2: #2a6bd1;
      }
      .bars.device {
        --c1: #b94be0;
        --c2: #ff2e97;
      }
      .gl {
        position: absolute;
        left: 0;
        right: 0;
        border-top: 1px dashed rgba(127, 127, 127, 0.16);
        pointer-events: none;
      }
      .bar {
        flex: 1;
        height: 100%;
        display: flex;
        align-items: flex-end;
        background: none;
        border: 0;
        padding: 0;
        cursor: pointer;
        -webkit-tap-highlight-color: transparent;
      }
      .bar span {
        width: 100%;
        border-radius: 6px 6px 2px 2px;
        background: linear-gradient(180deg, var(--c1), var(--c2));
        transition: height 0.35s ease, opacity 0.2s;
      }
      .bar.dim span {
        opacity: 0.3;
      }
      .bar.sel span {
        box-shadow: 0 0 0 2px var(--c1);
      }
      .bar.future {
        cursor: default;
      }
      .axis {
        display: flex;
        gap: 4px;
        font-size: 12px;
        margin-top: 6px;
      }
      .axis span {
        flex: 1;
        text-align: center;
        white-space: nowrap;
        overflow: visible;
      }
    `,
  ];
}

function fmtKwh(k: number) {
  return `${k >= 100 ? Math.round(k) : k.toFixed(k >= 10 ? 1 : 2)} kWh`;
}

reg("panel-energy", PageEnergy);
