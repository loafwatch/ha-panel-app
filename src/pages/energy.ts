import { reg } from "../registry";
import { css, html, nothing, svg } from "lit";
import { state } from "lit/decorators.js";
import { PageBase } from "./base";

interface Pt {
  t: number;
  v: number;
}

export class PageEnergy extends PageBase {
  @state() private series: Pt[] = [];
  @state() private hours = 24;
  private loaded = 0;
  private loadedHours = 0;

  protected watched() {
    const e = this.config.energy;
    return [e?.power, e?.rate, ...(e?.costs ?? []).map((c) => c.entity)].filter(Boolean) as string[];
  }

  protected updated(c: Map<string, unknown>) {
    super.updated(c as any);
    if (this.active && (Date.now() - this.loaded > 5 * 60 * 1000 || this.loadedHours !== this.hours)) this.load();
  }

  private async load() {
    const id = this.config.energy?.power;
    if (!id) return;
    this.loaded = Date.now();
    this.loadedHours = this.hours;
    const start = new Date(Date.now() - this.hours * 3600 * 1000);
    try {
      const r = await this.hass.callWS<Record<string, { s: string; lu: number }[]>>({
        type: "history/history_during_period",
        start_time: start.toISOString(),
        entity_ids: [id],
        minimal_response: true,
        no_attributes: true,
      });
      const raw = (r[id] ?? []).map((x) => ({ t: x.lu * 1000, v: Number(x.s) })).filter((x) => !isNaN(x.v));
      // average into buckets so the chart stays light
      const bucket = (this.hours * 3600 * 1000) / 144;
      const out: Pt[] = [];
      let i = 0;
      let last = raw[0]?.v ?? 0;
      for (let b = start.getTime(); b < Date.now(); b += bucket) {
        let sum = 0;
        let n = 0;
        while (i < raw.length && raw[i].t < b + bucket) {
          sum += raw[i].v;
          n++;
          last = raw[i].v;
          i++;
        }
        out.push({ t: b, v: n ? sum / n : last });
      }
      this.series = out;
    } catch (e) {
      console.warn("ha-panel-app: energy history", e);
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
        <div class="tile chart">
          <div class="chead">
            <div class="label"><ha-icon icon="mdi:chart-areaspline"></ha-icon>Power</div>
            <div class="seg">
              ${[6, 24, 48].map((h) => html`<button class="chip ${this.hours === h ? "on" : ""}" @click=${() => (this.hours = h)}>${h}h</button>`)}
            </div>
          </div>
          ${this.chart()}
        </div>
      </div>
    `;
  }

  private chart() {
    const s = this.series;
    if (s.length < 2) return html`<div class="empty">Loading…</div>`;
    const W = 1000;
    const H = 260;
    const max = Math.max(500, ...s.map((p) => p.v)) * 1.1;
    const x = (i: number) => (i / (s.length - 1)) * W;
    const y = (v: number) => H - (v / max) * H;
    const line = s.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join("");
    const area = `${line}L${W},${H}L0,${H}Z`;
    const peak = s.reduce((a, b) => (b.v > a.v ? b : a));
    const avg = s.reduce((a, b) => a + b.v, 0) / s.length;
    const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => new Date(s[0].t + f * (s[s.length - 1].t - s[0].t)));
    return html`
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="svg">
        <defs>
          <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="#ff2e97" stop-opacity="0.45" />
            <stop offset="1" stop-color="#00c8d4" stop-opacity="0.02" />
          </linearGradient>
          <linearGradient id="l" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stop-color="#00c8d4" />
            <stop offset="1" stop-color="#ff2e97" />
          </linearGradient>
        </defs>
        ${[0.25, 0.5, 0.75].map((f) => svg`<line x1="0" x2="${W}" y1="${H * f}" y2="${H * f}" class="grid" />`)}
        <path d=${area} fill="url(#g)" />
        <path d=${line} fill="none" stroke="url(#l)" stroke-width="3" vector-effect="non-scaling-stroke" />
      </svg>
      <div class="axis muted">${ticks.map((t) => html`<span>${t.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</span>`)}</div>
      <div class="stats">
        <span>Peak <b>${fmtW(peak.v)}</b> at ${new Date(peak.t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</span>
        <span>Average <b>${fmtW(avg)}</b></span>
      </div>
    `;
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
      .seg .chip {
        padding: 6px 14px;
      }
      .svg {
        width: 100%;
        height: 260px;
        margin-top: 10px;
        display: block;
      }
      .grid {
        stroke: rgba(127, 127, 127, 0.18);
        stroke-width: 1;
        vector-effect: non-scaling-stroke;
      }
      .axis {
        display: flex;
        justify-content: space-between;
        font-size: 12px;
        margin-top: 6px;
      }
      .stats {
        display: flex;
        gap: 28px;
        margin-top: 14px;
        font-size: 15px;
        color: var(--text-2);
      }
      .stats b {
        color: var(--text);
      }
    `,
  ];
}

function fmtW(w: number) {
  return w >= 1000 ? `${(w / 1000).toFixed(2)} kW` : `${Math.round(w)} W`;
}

reg("panel-energy", PageEnergy);
