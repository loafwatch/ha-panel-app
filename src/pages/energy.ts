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
  /** Day view: how many months back from the current month. */
  @state() private monthOff = 0;
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

  private slots(): { start: Date; end?: Date; starts: number[]; period: "day" | "month" } {
    const now = new Date();
    const mid = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    switch (this.range) {
      case "day": {
        // every day of one calendar month (the current one, or monthOff months back)
        const m0 = new Date(now.getFullYear(), now.getMonth() - this.monthOff, 1);
        const m1 = new Date(m0.getFullYear(), m0.getMonth() + 1, 1);
        const out: number[] = [];
        for (let d = new Date(m0); d < m1; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) out.push(d.getTime());
        return { start: m0, end: m1, starts: out, period: "day" };
      }
      case "week": {
        // the last 12 weeks, each starting on a Monday
        const mon = new Date(mid.getFullYear(), mid.getMonth(), mid.getDate() - ((mid.getDay() + 6) % 7));
        const out: number[] = [];
        for (let i = 11; i >= 0; i--) out.push(new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() - 7 * i).getTime());
        return { start: new Date(out[0]), starts: out, period: "day" };
      }
      case "month": {
        const out: number[] = [];
        for (let i = 11; i >= 0; i--) out.push(new Date(now.getFullYear(), now.getMonth() - i, 1).getTime());
        return { start: new Date(out[0]), starts: out, period: "month" };
      }
      case "year": {
        // up to five calendar years; years before the first readings are dropped after loading
        const out: number[] = [];
        for (let i = 4; i >= 0; i--) out.push(new Date(now.getFullYear() - i, 0, 1).getTime());
        return { start: new Date(out[0]), starts: out, period: "month" };
      }
    }
  }

  private loadKey() {
    return this.range + "|" + this.kind + "|" + (this.range === "day" ? this.monthOff : 0);
  }

  private async load() {
    const src = this.sources[this.kind];
    const key = this.loadKey();
    this.loadedKey = key;
    this.loadedAt = Date.now();
    if (!src) return;
    const { start, end, starts, period } = this.slots();
    const devs = this.kind === "electricity" ? (this.config.energy?.devices ?? []) : [];
    const devIds = devs.map((d) => d.energy);
    const ids = [...new Set([src.energy, src.cost, ...devIds].filter(Boolean))] as string[];
    try {
      const r = await this.hass.callWS<Record<string, { start: number | string; change?: number | null }[]>>({
        type: "recorder/statistics_during_period",
        start_time: start.toISOString(),
        ...(end ? { end_time: end.toISOString() } : {}),
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
      // Long-term statistics lag "now" by up to an hour. Work out today's shortfall from the
      // five-minute statistics and add it to whichever slot contains today.
      let cur = -1;
      for (let i = 0; i < starts.length; i++) if (starts[i] <= now) cur = i;
      const extra: Record<string, number> = {};
      if (cur >= 0 && (!end || now < end.getTime())) {
        const d0 = new Date();
        d0.setHours(0, 0, 0, 0);
        try {
          const q = (p: "hour" | "5minute") =>
            this.hass.callWS<Record<string, { change?: number | null }[]>>({
              type: "recorder/statistics_during_period",
              start_time: d0.toISOString(),
              statistic_ids: ids,
              period: p,
              types: ["change"],
            });
          const [rh, r5] = await Promise.all([q("hour"), q("5minute")]);
          const sum = (rows?: { change?: number | null }[]) => (rows ?? []).reduce((acc, row) => acc + (row.change ?? 0), 0);
          for (const id of ids) extra[id] = Math.max(0, sum(r5[id]) - sum(rh[id]));
        } catch (e) {
          console.warn("ha-panel-app: 5-minute statistics", e);
        }
      }
      const pick0 = pick;
      const pickT = (id?: string) => {
        const m = pick0(id);
        if (id && cur >= 0 && extra[id]) m.set(cur, (m.get(cur) ?? 0) + extra[id]);
        return m;
      };
      const kwh = pickT(src.energy);
      const cost = src.cost ? pickT(src.cost) : undefined;
      const partMaps = devIds.map((id) => (id ? pickT(id) : undefined));
      let bars: Bar[] = starts.map((t, i) => {
        const parts = partMaps.map((m) => Math.max(0, m?.get(i) ?? 0));
        const hi = this.dev != null && partMaps[this.dev] ? parts[this.dev] : undefined;
        return { t, kwh: Math.max(0, kwh.get(i) ?? 0), hi, parts: partMaps.length ? parts : undefined, cost: cost?.get(i), future: t > now };
      });
      if (this.range === "year") {
        // start from the first year with readings
        const first = bars.findIndex((b) => b.kwh > 0);
        bars = first > 0 ? bars.slice(first) : bars.slice(-1);
      }
      this.bars = bars;
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
        <div class="lower">
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
                    }}
                  >
                    <ha-icon icon=${KIND_ICON[k]}></ha-icon>${KIND_LABEL[k]}
                  </button>`,
                )}
            </div>
            <div class="seg">
              ${RANGES.map(
                (r) => html`<button
                  class="chip ${this.range === r.id ? "on" : ""}"
                  @click=${() => {
                    if (r.id === "day" && this.range !== "day") this.monthOff = 0;
                    this.range = r.id;
                  }}
                >${r.label}</button>`,
              )}
            </div>
          </div>
          ${this.chart()}
        </div>
        ${this.bdCard()}
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
    const unitWord = { day: "a day", week: "a week", month: "a month", year: "a year" }[this.range];
    const dev = this.dev != null ? this.config.energy?.devices?.[this.dev] : undefined;
    const hiOf = (b: Bar) => (this.dev != null ? b.parts?.[this.dev] : undefined);
    const hiOn = !!dev && this.kind === "electricity" && bars.some((b) => hiOf(b) != null);
    const hiTotal = hiOn ? past.reduce((s, b) => s + (hiOf(b) ?? 0), 0) : 0;
    const share = hiOn && total > 0 ? Math.round((hiTotal / total) * 100) : undefined;
    return html`
      <div class="sum">
        ${this.range === "day"
          ? html`<div class="mnav">
              <button class="x" aria-label="Previous month" @click=${() => this.monthOff++}><ha-icon icon="mdi:chevron-left"></ha-icon></button>
              <button class="x" aria-label="Next month" ?disabled=${this.monthOff === 0} @click=${() => (this.monthOff = Math.max(0, this.monthOff - 1))}><ha-icon icon="mdi:chevron-right"></ha-icon></button>
            </div>`
          : nothing}
        <div class="sumtxt">
        ${sel
          ? html`<div class="big">${this.amt(sel.kwh)}${sel.cost != null ? html`<span class="cost">£${sel.cost.toFixed(2)}</span>` : nothing}${hiOn && hiOf(sel) != null ? html`<span class="hi">${dev!.name} ${this.amt(hiOf(sel)!)}${sel.kwh > 0 ? ` · ${Math.round((hiOf(sel)! / sel.kwh) * 100)}%` : ""}</span>` : nothing}</div>
              <div class="muted">${this.slotLabel(sel.t, true)}</div>`
          : html`<div class="big">${this.amt(total)}${hasCost ? html`<span class="cost">£${totalCost.toFixed(2)}</span>` : nothing}${hiOn ? html`<span class="hi">${dev!.name} ${this.amt(hiTotal)} · ${share ?? 0}%</span>` : nothing}</div>
              <div class="muted">${this.rangeLabel()}${withData.length ? ` · average ${this.amt(avg)} ${unitWord}` : ""}</div>`}
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
    `;
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

  /** Right-hand card: appliance breakdown for the period, or for the tapped bar. */
  private bdCard() {
    const devs = this.config.energy?.devices ?? [];
    if (this.kind !== "electricity" || !devs.some((d) => d.energy)) return nothing;
    const bars = this.bars ?? [];
    const sel = this.sel != null ? bars[this.sel] : undefined;
    const past = bars.filter((b) => !b.future);
    const n = devs.length;
    const whole: Bar | undefined = past.length
      ? {
          t: past[0].t,
          future: false,
          kwh: past.reduce((s, b) => s + b.kwh, 0),
          parts: past.some((b) => b.parts) ? Array.from({ length: n }, (_, i) => past.reduce((s, b) => s + (b.parts?.[i] ?? 0), 0)) : undefined,
        }
      : undefined;
    const target = sel ?? whole;
    const unit = this.range;
    return html`<div class="tile bdcard">
      <div class="label bdhead">
        <ha-icon icon="mdi:chart-donut"></ha-icon>
        <span class="grow">${sel ? this.slotLabel(sel.t, true) : this.rangeLabel()}</span>
        ${sel
          ? html`<button class="x" aria-label="Back to the whole period" @click=${() => (this.sel = undefined)}><ha-icon icon="mdi:close"></ha-icon></button>`
          : nothing}
      </div>
      ${target ? this.breakdown(target) : html`<div class="muted">Loading…</div>`}
      <div class="muted bdhint">Tap an appliance to highlight it${sel ? "" : ` · tap a bar to see that ${unit}`}</div>
    </div>`;
  }

  /** What made up a selected bar: each appliance's kWh and share, plus everything else. */
  private breakdown(b: Bar) {
    const devs = this.config.energy?.devices ?? [];
    if (!b.parts || !devs.length || b.kwh <= 0) return html`<div class="muted">No readings for this period yet</div>`;
    const rows = devs
      .map((d, i) => ({ name: d.name, icon: d.icon, power: d.power, v: b.parts![i] ?? 0, i }))
      .filter((r) => r.v > 0.005)
      .sort((p, q) => q.v - p.v);
    const known = rows.reduce((s, r) => s + r.v, 0);
    const other = Math.max(0, b.kwh - known);
    const pct = (v: number) => Math.round((v / b.kwh) * 100);
    return html`<div class="bd">
      ${rows.map(
        (r) => html`<button class="bdrow ${this.dev === r.i ? "on" : ""}" @click=${() => (this.dev = this.dev === r.i ? undefined : r.i)}>
          <ha-icon icon=${r.icon ?? "mdi:power-plug-outline"}></ha-icon>
          <span class="bdn">${r.name}<small>${this.liveW(r.power)}</small></span>
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
        return i === 0 || (i + 1) % 5 === 0 ? String(d.getDate()) : "";
      case "week":
        return i % 2 === (this.bars.length - 1) % 2 ? d.toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "";
      case "month":
        return d.toLocaleDateString("en-GB", { month: "short" });
      case "year":
        return String(d.getFullYear());
    }
  }

  private slotLabel(t: number, long = false) {
    const d = new Date(t);
    switch (this.range) {
      case "week":
        return "Week commencing " + d.toLocaleDateString("en-GB", { weekday: long ? "long" : "short", day: "numeric", month: "long" });
      case "month":
        return d.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
      case "year":
        return String(d.getFullYear()) + (d.getFullYear() === new Date().getFullYear() ? " so far" : "");
      default:
        return d.toLocaleDateString("en-GB", { weekday: long ? "long" : "short", day: "numeric", month: "long" });
    }
  }

  private rangeLabel() {
    switch (this.range) {
      case "day": {
        const now = new Date();
        return new Date(now.getFullYear(), now.getMonth() - this.monthOff, 1).toLocaleDateString("en-GB", { month: "long", year: "numeric" });
      }
      case "week":
        return "Last 12 weeks";
      case "month":
        return "Last 12 months";
      case "year": {
        const b = this.bars;
        return b.length > 1 ? `${new Date(b[0].t).getFullYear()}–${new Date(b[b.length - 1].t).getFullYear()}` : "This year";
      }
    }
  }

  static styles = [
    PageBase.styles,
    css`
      .mnav {
        display: flex;
        gap: 4px;
        margin-right: 10px;
      }
      .sum:has(.mnav) {
        display: flex;
        align-items: center;
      }
      .mnav button {
        display: grid;
        place-items: center;
        width: 44px;
        height: 44px;
        border-radius: 50%;
        border: 0;
        background: var(--tile-2);
        color: inherit;
        cursor: pointer;
        --mdc-icon-size: 26px;
      }
      .mnav button[disabled] {
        opacity: 0.3;
      }
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
      /* graph card on the left, appliance breakdown card on the right */
      .lower {
        flex: 1;
        min-height: 0;
        display: flex;
        gap: var(--gap, 16px);
      }
      .lower .chart {
        flex: 1;
        min-width: 0;
      }
      .bdcard {
        flex: none;
        width: 460px;
        min-height: 0;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .bdcard .bd {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        align-content: start;
      }
      .bdhead {
        display: flex;
        align-items: center;
      }
      .bdhead .grow {
        flex: 1;
      }
      .bdcard .x {
        display: grid;
        place-items: center;
        width: 36px;
        height: 36px;
        margin: -8px -6px -8px 0;
        border-radius: 50%;
        border: 0;
        background: transparent;
        color: var(--text-2);
        cursor: pointer;
        --mdc-icon-size: 20px;
      }
      .bdhint {
        font-size: 12px;
      }
      .bdn small .w {
        margin-left: 6px;
        font-size: 11px;
        color: var(--cy);
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
        .lower {
          flex-direction: column;
          flex: none;
        }
        .bdcard {
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
        grid-template-columns: 22px minmax(150px, auto) 1fr 40px 66px;
        align-items: center;
        gap: 8px;
        font-size: 15px;
        background: none;
        border: 0;
        padding: 7px 6px;
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
