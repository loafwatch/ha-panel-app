import { reg } from "../registry";
import { css, html, nothing } from "lit";
import { state } from "lit/decorators.js";
import { PageBase } from "./base";
import { fmtTime } from "../util";

type Range = "day" | "week" | "month" | "year";
type Kind = "electricity" | "gas" | "water";
interface Bar {
  t: number;
  kwh: number;
  /** the highlighted device's share of this slot (kWh) */
  hi?: number;
  /** every appliance's kWh for this slot, in config order */
  parts?: number[];
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
  /** Index of the appliance cross-highlighted on the chart, if any. */
  @state() private dev?: number;
  private loadedKey = "";
  private loadedAt = 0;
  private prefsLoaded = false;

  protected watched() {
    const e = this.config.energy;
    return [e?.power, e?.rate, ...(e?.costs ?? []).map((c) => c.entity), ...(e?.devices ?? []).map((d) => d.power), e?.octopus?.points, ...(e?.octopus?.spins ?? [])].filter(Boolean) as string[];
  }

  protected updated(c: Map<string, unknown>) {
    super.updated(c as any);
    if (!this.active) return;
    if (!this.prefsLoaded) {
      this.prefsLoaded = true;
      this.loadPrefs();
      return;
    }
    const key = this.loadKey();
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
        if (s.type === "water" && s.stat_energy_from && !src.water) src.water = { energy: s.stat_energy_from, cost: s.stat_cost ?? undefined };
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

  private loadKey() {
    return this.range + "|" + this.kind;
  }

  private async load() {
    const src = this.sources[this.kind];
    const key = this.loadKey();
    this.loadedKey = key;
    this.loadedAt = Date.now();
    if (!src) return;
    const { start, starts, period } = this.slots();
    const devs = this.kind === "electricity" ? (this.config.energy?.devices ?? []) : [];
    const devIds = devs.map((d) => d.energy);
    const ids = [...new Set([src.energy, src.cost, ...devIds].filter(Boolean))] as string[];
    try {
      const r = await this.hass.callWS<Record<string, { start: number | string; change?: number | null }[]>>({
        type: "recorder/statistics_during_period",
        start_time: start.toISOString(),
        statistic_ids: ids,
        period,
        types: ["change"],
      });
      if (key !== this.loadKey()) return; // user moved on
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
      const now = Date.now();
      // The slot containing "now" lags by up to an hour in the hourly statistics, so top it up
      // from the five-minute statistics, which are only a few minutes behind.
      const now0 = Date.now();
      let cur = -1;
      for (let i = 0; i < starts.length; i++) if (starts[i] <= now0) cur = i;
      if (cur >= 0) {
        try {
          const r5 = await this.hass.callWS<Record<string, { start: number | string; change?: number | null }[]>>({
            type: "recorder/statistics_during_period",
            start_time: new Date(starts[cur]).toISOString(),
            statistic_ids: ids,
            period: "5minute",
            types: ["change"],
          });
          for (const id of ids) {
            const rows = r5[id];
            if (!rows?.length) continue;
            const sum = rows.reduce((acc, row) => acc + (row.change ?? 0), 0);
            // keep whichever is larger: hourly stats can be partially compiled for this slot
            const prev = r[id]?.filter((row) => (typeof row.start === "number" ? row.start : Date.parse(row.start)) >= starts[cur] - 60_000) ?? [];
            const hourly = prev.reduce((acc, row) => acc + (row.change ?? 0), 0);
            r[id] = [...(r[id] ?? []).filter((row) => !prev.includes(row)), { start: starts[cur], change: Math.max(sum, hourly) }];
          }
        } catch (e) {
          console.warn("ha-panel-app: 5-minute statistics", e);
        }
      }
      const kwh = pick(src.energy);
      const cost = src.cost ? pick(src.cost) : undefined;
      const partMaps = devIds.map((id) => (id ? pick(id) : undefined));
      this.bars = starts.map((t, i) => {
        const parts = partMaps.map((m) => Math.max(0, m?.get(i) ?? 0));
        const hi = this.dev != null && partMaps[this.dev] ? parts[this.dev] : undefined;
        return { t, kwh: Math.max(0, kwh.get(i) ?? 0), hi, parts: partMaps.length ? parts : undefined, cost: cost?.get(i), future: t > now };
      });
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
      <div class="page fill">
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
                ${this.octoplus()}
              </div>`
            : nothing}
        </div>
        <div class="tile chart">
          <div class="chead">
            <div class="seg">
              ${(["electricity", "gas", "water"] as Kind[])
                .filter((k) => this.sources[k])
                .map(
                  (k) => html`<button
                    class="chip ${this.kind === k ? "on" : ""}"
                    @click=${() => {
                      this.kind = k;
                      if (k !== "electricity") this.dev = undefined;
                      // water readings are daily, so there's no hourly "Day" view
                      if (k === "water" && this.range === "day") this.range = "week";
                    }}
                  >
                    <ha-icon icon=${KIND_ICON[k]}></ha-icon>${KIND_LABEL[k]}
                  </button>`,
                )}
            </div>
            <div class="seg">
              ${RANGES.filter((r) => !(this.kind === "water" && r.id === "day")).map(
                (r) => html`<button class="chip ${this.range === r.id ? "on" : ""}" @click=${() => (this.range = r.id)}>${r.label}</button>`,
              )}
            </div>
          </div>
          ${this.kind === "electricity" && en.devices?.length
            ? html`<div class="devrow">
                <span class="devlabel muted">Highlight</span>
                ${en.devices.map((d, i) =>
                  d.energy
                    ? html`<button class="chip dev ${this.dev === i ? "on" : ""}" @click=${() => (this.dev = this.dev === i ? undefined : i)}>
                        <ha-icon icon=${d.icon ?? "mdi:power-plug-outline"}></ha-icon>${d.name}${this.liveW(d.power)}
                      </button>`
                    : nothing,
                )}
              </div>`
            : nothing}
          ${this.chart()}
        </div>
      </div>
    `;
  }

  private chart() {
    if (!this.sources.electricity && !this.sources.gas && !this.sources.water)
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
    const dev = this.dev != null ? this.config.energy?.devices?.[this.dev] : undefined;
    const hiOf = (b: Bar) => (this.dev != null ? b.parts?.[this.dev] : undefined);
    const hiOn = !!dev && this.kind === "electricity" && bars.some((b) => hiOf(b) != null);
    const hiTotal = hiOn ? past.reduce((s, b) => s + (hiOf(b) ?? 0), 0) : 0;
    const share = hiOn && total > 0 ? Math.round((hiTotal / total) * 100) : undefined;
    const bd = sel ? this.breakdown(sel) : nothing;
    return html`<div class="cwrap ${bd !== nothing ? "split" : ""}">
      <div class="cmain">
      <div class="sum">
        <div class="sumtxt">
        ${sel
          ? html`<div class="big">${this.amt(sel.kwh)}${sel.cost != null ? html`<span class="cost">£${sel.cost.toFixed(2)}</span>` : nothing}${hiOn && hiOf(sel) != null ? html`<span class="hi">${dev!.name} ${this.amt(hiOf(sel)!)}${sel.kwh > 0 ? ` · ${Math.round((hiOf(sel)! / sel.kwh) * 100)}%` : ""}</span>` : nothing}</div>
              <div class="muted">${this.slotLabel(sel.t, true)}</div>`
          : html`<div class="big">${this.amt(total)}${hasCost ? html`<span class="cost">£${totalCost.toFixed(2)}</span>` : nothing}${hiOn ? html`<span class="hi">${dev!.name} ${this.amt(hiTotal)} · ${share ?? 0}%</span>` : nothing}</div>
              <div class="muted">${this.rangeLabel()} · average ${this.amt(avg)} ${unitWord}</div>`}
        </div>
      </div>
      <div class="bars ${this.kind} ${hiOn ? "hilite" : ""}" @click=${(e: Event) => e.target === e.currentTarget && (this.sel = undefined)}>
        ${[0.25, 0.5, 0.75].map((f) => html`<i class="gl" style="bottom:${f * 100}%"></i>`)}
        ${bars.map(
          (b, i) => html`<button
            class="bar ${b.future ? "future" : ""} ${this.sel === i ? "sel" : ""} ${this.sel != null && this.sel !== i ? "dim" : ""}"
            ?disabled=${b.future}
            @click=${() => (this.sel = this.sel === i ? undefined : i)}
            aria-label=${this.slotLabel(b.t, true) + " " + this.amt(b.kwh)}
          >
            <span class="tot" style="height:${b.future ? 0 : Math.max(b.kwh > 0 ? 2 : 0, (b.kwh / max) * 100)}%"></span>
            <span class="part" style="height:${b.future || !hiOn ? 0 : ((hiOf(b) ?? 0) / max) * 100}%"></span>
          </button>`,
        )}
      </div>
      <div class="axis muted">${bars.map((b, i) => html`<span>${this.tickLabel(b.t, i)}</span>`)}</div>
      </div>
      ${bd !== nothing
        ? html`<aside class="side">
            <div class="sidehead"><span>Breakdown</span><button class="x" aria-label="Close breakdown" @click=${() => (this.sel = undefined)}><ha-icon icon="mdi:close"></ha-icon></button></div>
            ${bd}
          </aside>`
        : nothing}
    </div>`;
  }

  /** Octoplus line: points, free spins and the next saving session. */
  private octoplus() {
    const o = this.config.energy?.octopus;
    if (!o) return nothing;
    const pts = Number(this.st(o.points)?.state);
    const spins = (o.spins ?? []).reduce((n, id) => n + (Number(this.st(id)?.state) || 0), 0);
    const next = this.hub.savings[0];
    const bits = [];
    if (!isNaN(pts)) bits.push(html`<span><ha-icon icon="mdi:trophy-outline"></ha-icon>${pts.toLocaleString("en-GB")} Octopoints</span>`);
    if (spins > 0) bits.push(html`<span><ha-icon icon="mdi:star-circle-outline"></ha-icon>${spins} free spin${spins === 1 ? "" : "s"}</span>`);
    if (next)
      bits.push(
        html`<span class="sv"><ha-icon icon="mdi:leaf"></ha-icon>Saving session ${next.start.toDateString() === new Date().toDateString() ? "today" : next.start.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })} ${fmtTime(next.start)}</span>`,
      );
    return bits.length ? html`<div class="octo">${bits}</div>` : nothing;
  }

  /** kWh for electricity and gas, litres for water. */
  private amt(v: number) {
    return this.kind === "water" ? fmtLitres(v) : fmtKwh(v);
  }

  /** Live draw for a chip: "· 70 W", "· 1.8 kW", or nothing when off/unknown. */
  private liveW(power?: string) {
    const w = Number(this.st(power)?.state);
    if (isNaN(w) || w < 5) return nothing;
    return html`<span class="w">${w >= 1000 ? (w / 1000).toFixed(1) + " kW" : Math.round(w) + " W"}</span>`;
  }

  /** What made up a selected bar: each appliance's kWh and share, plus everything else. */
  private breakdown(b: Bar) {
    const devs = this.config.energy?.devices ?? [];
    if (!b.parts || !devs.length || b.kwh <= 0 || this.kind !== "electricity") return nothing;
    const rows = devs.map((d, i) => ({ name: d.name, icon: d.icon, v: b.parts![i], i })).filter((r) => r.v > 0.005).sort((p, q) => q.v - p.v);
    const known = rows.reduce((s, r) => s + r.v, 0);
    const other = Math.max(0, b.kwh - known);
    const pct = (v: number) => Math.round((v / b.kwh) * 100);
    return html`<div class="bd">
      ${rows.map(
        (r) => html`<button class="bdrow ${this.dev === r.i ? "on" : ""}" @click=${() => (this.dev = this.dev === r.i ? undefined : r.i)}>
          <ha-icon icon=${r.icon ?? "mdi:power-plug-outline"}></ha-icon>
          <span class="bdn">${r.name}</span>
          <span class="bdbar"><i style="width:${pct(r.v)}%"></i></span>
          <b>${pct(r.v)}%</b><span class="muted">${this.amt(r.v)}</span>
        </button>`,
      )}
      ${rows.length
        ? html`<div class="bdrow other">
            <ha-icon icon="mdi:home-lightning-bolt-outline"></ha-icon>
            <span class="bdn">Everything else</span>
            <span class="bdbar"><i style="width:${pct(other)}%"></i></span>
            <b>${pct(other)}%</b><span class="muted">${this.amt(other)}</span>
          </div>`
        : html`<div class="muted">No appliance readings for this period yet</div>`}
    </div>`;
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
      .page.fill {
        display: flex;
        flex-direction: column;
        height: 100%;
        overflow: hidden;
      }
      .cards {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
        gap: var(--gap);
        margin-bottom: var(--gap);
        flex: none;
      }
      .chart {
        flex: 1;
        min-height: 0;
        display: flex;
        flex-direction: column;
      }
      .chart .bars {
        flex: 1;
        min-height: 120px;
        height: auto;
      }
      /* chart on the left, appliance breakdown alongside it when a bar is picked */
      .cwrap {
        flex: 1;
        min-height: 0;
        display: flex;
        gap: 20px;
      }
      .cmain {
        flex: 1;
        min-width: 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
      }
      .side {
        flex: none;
        width: 400px;
        min-height: 0;
        overflow-y: auto;
        padding: 12px 14px;
        border-radius: 16px;
        background: var(--tile-2, rgba(255, 255, 255, 0.05));
        align-self: stretch;
        animation: sidein 0.18s ease-out;
      }
      @keyframes sidein {
        from {
          opacity: 0;
          transform: translateX(12px);
        }
      }
      .sidehead {
        display: flex;
        align-items: center;
        justify-content: space-between;
        font-size: 13px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--text-2);
        margin-bottom: 6px;
      }
      .side .x {
        display: grid;
        place-items: center;
        width: 36px;
        height: 36px;
        border-radius: 50%;
        border: 0;
        background: transparent;
        color: var(--text-2);
        cursor: pointer;
        --mdc-icon-size: 20px;
      }
      .side .bd {
        flex: none;
      }
      /* phones: let the page scroll and give the chart a fixed height */
      @media (max-width: 700px) {
        .page.fill {
          height: auto;
          overflow: visible;
        }
        .cards {
          grid-template-columns: 1fr;
        }
        .chart {
          flex: none;
        }
        .cwrap {
          flex-direction: column;
        }
        .side {
          width: auto;
        }
        .chart .bars {
          flex: none;
          height: 240px;
        }
        .huge {
          font-size: 48px !important;
        }
        .devrow {
          flex-wrap: nowrap !important;
          scrollbar-width: none;
          overflow-x: auto;
          padding-bottom: 4px;
        }
        .devrow > * {
          flex: none;
        }
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
      .seg {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      .octo {
        display: flex;
        flex-wrap: wrap;
        gap: 6px 16px;
        margin-top: 10px;
        padding-top: 10px;
        border-top: 1px solid rgba(127, 127, 127, 0.14);
        font-size: 13px;
        color: var(--text-2);
      }
      .octo span {
        display: inline-flex;
        align-items: center;
        gap: 5px;
      }
      .octo ha-icon {
        --mdc-icon-size: 16px;
      }
      .octo .sv {
        color: var(--cy);
        font-weight: 600;
      }
      .devrow {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px;
        margin-top: 10px;
        padding-top: 10px;
        border-top: 1px solid rgba(127, 127, 127, 0.14);
      }
      .devlabel {
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        margin-right: 4px;
      }
      .devrow .chip {
        padding: 6px 12px;
        font-size: 14px;
      }
      .chip .w {
        font-weight: 400;
        opacity: 0.8;
        margin-left: 4px;
      }
      .chip.dev.on .w {
        opacity: 1;
      }
      .sum {
        margin: 12px 0 8px;
        min-height: 62px;
        flex: none;
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
      .bars.water {
        --c1: #3ba7ff;
        --c2: #1c4fd8;
      }
      .bars.gas {
        --c1: #00c8d4;
        --c2: #2a6bd1;
      }
      .sum.withbd {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 24px;
      }
      .sumtxt {
        flex: none;
      }
      .bd {
        display: grid;
        gap: 2px;
        flex: 0 1 520px;
        min-width: 0;
      }
      .bdrow {
        display: grid;
        grid-template-columns: 22px 130px 1fr 42px 64px;
        align-items: center;
        gap: 8px;
        font-size: 13px;
        background: none;
        border: 0;
        padding: 2px 6px;
        border-radius: 8px;
        color: var(--text);
        text-align: left;
        cursor: pointer;
      }
      .bdrow.on {
        background: var(--tile-2);
      }
      .bdrow ha-icon {
        --mdc-icon-size: 18px;
        color: var(--text-2);
      }
      .bdrow.on ha-icon {
        color: var(--cy);
      }
      .bdn {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .bdbar {
        height: 8px;
        border-radius: 4px;
        background: rgba(127, 127, 127, 0.2);
        overflow: hidden;
      }
      .bdbar i {
        display: block;
        height: 100%;
        background: var(--cy);
        transition: width 0.5s cubic-bezier(0.2, 0.8, 0.2, 1);
      }
      .bdrow.other .bdbar i {
        background: var(--c1, var(--accent));
        opacity: 0.6;
      }
      .bdrow b {
        text-align: right;
      }
      .sum {
        min-height: 62px;
      }
      .hi {
        font-size: 18px;
        color: var(--cy);
        font-weight: 600;
      }
      .chip.dev.on {
        background: var(--cy);
        border-color: var(--cy);
        color: #04262a;
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
        position: relative;
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
      .bar .part {
        position: absolute;
        left: 0;
        right: 0;
        bottom: 0;
        border-radius: 6px 6px 2px 2px;
        background: var(--cy);
        box-shadow: 0 0 10px rgba(0, 200, 212, 0.45);
        transition: height 0.5s cubic-bezier(0.2, 0.8, 0.2, 1);
      }
      .bars.hilite .tot {
        opacity: 0.28;
      }
      .bar.dim span {
        opacity: 0.3;
      }
      .bar.dim .part {
        opacity: 0.4;
      }
      .bar.sel .tot {
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

function fmtLitres(l: number) {
  return l >= 10000 ? `${(l / 1000).toFixed(l >= 100000 ? 0 : 1)} m³` : `${Math.round(l).toLocaleString("en-GB")} L`;
}

const KIND_ICON: Record<Kind, string> = { electricity: "mdi:flash", gas: "mdi:fire", water: "mdi:water" };
const KIND_LABEL: Record<Kind, string> = { electricity: "Electricity", gas: "Gas", water: "Water" };

reg("panel-energy", PageEnergy);
