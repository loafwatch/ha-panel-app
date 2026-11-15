import { reg } from "../registry";
import { css, html, nothing, svg } from "lit";
import { PageBase } from "./base";
import type { TransitConfig, TransitDeparture } from "../types";

/**
 * A tram/bus line as a strip map. Two sensors (one per terminus) carry the next
 * departures; positions of vehicles already on the line are estimated from the
 * timetable run times in the config, and labelled as such unless the board
 * says a departure is tracked live.
 */
interface Dep {
  at: Date; // departure from the terminus
  live: boolean;
  to: string;
}

interface Vehicle {
  dir: "ab" | "ba";
  frac: number; // 0..1 along the line from A to B
  stop: string; // nearest stop name
  label: string;
  live: boolean;
}

export class PageTransit extends PageBase {
  protected ticks = true;

  protected watched() {
    const t = this.config.transit;
    return [t?.a.sensor, t?.b.sensor].filter(Boolean) as string[];
  }

  /** Parse a board's departures into dates (today, or tomorrow if the time has passed by hours). */
  private deps(sensor: string): Dep[] {
    const st = this.st(sensor);
    const rows = (st?.attributes.departures ?? []) as TransitDeparture[];
    const now = new Date();
    const out: Dep[] = [];
    for (const r of rows) {
      let at: Date | undefined;
      const t = String(r.time ?? "").trim();
      const hm = t.match(/^(\d{1,2}):(\d{2})$/);
      const mins = t.match(/^(\d+)\s*min/i) ?? (t.toLowerCase() === "due" ? ["", "0"] : null);
      if (hm) {
        at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), +hm[1], +hm[2]);
        if (at.getTime() < now.getTime() - 3 * 3600_000) at = new Date(at.getTime() + 86400_000);
      } else if (mins) {
        at = new Date(now.getTime() + +mins[1] * 60_000);
      }
      if (at) out.push({ at, live: !!r.live, to: r.to });
    }
    return out.sort((x, y) => x.at.getTime() - y.at.getTime());
  }

  /** Vehicles on the line in one direction, from upcoming departures plus the
   *  headway worked backwards to cover trams that have already left. */
  private vehicles(dir: "ab" | "ba", deps: Dep[]): Vehicle[] {
    const t = this.config.transit!;
    const stops = t.stops;
    const total = dir === "ab" ? stops[stops.length - 1].ab : stops[0].ba;
    if (!deps.length || !total) return [];
    const now = Date.now();
    const headway = deps.length > 1 ? deps[1].at.getTime() - deps[0].at.getTime() : (t.headway_min ?? 12) * 60_000;
    const starts: { at: number; live: boolean }[] = deps.map((d) => ({ at: d.at.getTime(), live: d.live }));
    // trams that have already departed (estimated from the headway)
    for (let k = 1; k <= Math.ceil((total * 60_000) / Math.max(headway, 60_000)) + 1; k++) {
      const at = deps[0].at.getTime() - k * headway;
      if (at < now - total * 60_000) break;
      starts.push({ at, live: false });
    }
    const out: Vehicle[] = [];
    for (const s of starts) {
      const elapsed = (now - s.at) / 60_000;
      if (elapsed < 0 || elapsed > total + 1) continue;
      // find the segment the tram is in
      const seq = dir === "ab" ? stops : [...stops].reverse();
      const off = (x: (typeof stops)[0]) => (dir === "ab" ? x.ab : x.ba);
      let i = 0;
      while (i < seq.length - 1 && off(seq[i + 1]) <= elapsed) i++;
      const a = seq[i];
      const b = seq[Math.min(i + 1, seq.length - 1)];
      const span = Math.max(1, off(b) - off(a));
      const within = a === b ? 0 : Math.min(1, Math.max(0, (elapsed - off(a)) / span));
      const ia = stops.indexOf(a);
      const ib = stops.indexOf(b);
      const frac = (ia + (ib - ia) * within) / (stops.length - 1);
      const atStop = within < 0.15 ? a : within > 0.85 ? b : undefined;
      out.push({
        dir,
        frac,
        stop: atStop ? atStop.name : `${a.name} → ${b.name}`,
        label: atStop ? `at ${atStop.name}` : `between ${a.name} and ${b.name}`,
        live: s.live,
      });
    }
    return out;
  }

  render() {
    const t = this.config.transit;
    if (!t) return html`<div class="page"><div class="empty">No transit line configured.</div></div>`;
    const depsA = this.deps(t.a.sensor);
    const depsB = this.deps(t.b.sensor);
    const now = Date.now();
    const nextA = depsA.filter((d) => d.at.getTime() >= now - 60_000).slice(0, 4);
    const nextB = depsB.filter((d) => d.at.getTime() >= now - 60_000).slice(0, 3);
    const vehicles = [...this.vehicles("ab", depsA), ...this.vehicles("ba", depsB)];
    const stA = this.st(t.a.sensor);
    const updated = stA?.attributes.updated ? new Date(stA.attributes.updated) : undefined;
    const stale = !updated || now - updated.getTime() > 15 * 60_000;
    const anyLive = depsA.some((d) => d.live) || depsB.some((d) => d.live);
    const home = t.home ?? t.a.name;
    return html`
      <div class="page" style="--line:${t.color ?? "var(--accent)"}">
        <div class="top">
          <div class="tile next">
            <div class="label"><ha-icon icon=${t.icon ?? "mdi:tram"}></ha-icon>Next from ${t.a.name}</div>
            ${nextA.length
              ? html`<div class="first">
                    <span class="mins">${mins(nextA[0].at)}</span>
                    <span class="sub">to ${nextA[0].to}${nextA[0].live ? html` <i class="live">live</i>` : nothing}</span>
                  </div>
                  <div class="more">${nextA.slice(1).map((d) => html`<span>${hm(d.at)}${d.live ? html`<i class="live">live</i>` : nothing}</span>`)}</div>`
              : html`<div class="empty">${stale ? "Waiting for the departure board…" : "No more departures listed"}</div>`}
          </div>
          <div class="tile next b">
            <div class="label"><ha-icon icon=${t.icon ?? "mdi:tram"}></ha-icon>Next from ${t.b.name}</div>
            ${nextB.length
              ? html`<div class="first">
                    <span class="mins">${mins(nextB[0].at)}</span>
                    <span class="sub">to ${nextB[0].to}${nextB[0].live ? html` <i class="live">live</i>` : nothing}</span>
                  </div>
                  <div class="more">${nextB.slice(1).map((d) => html`<span>${hm(d.at)}</span>`)}</div>`
              : html`<div class="empty">${stale ? "Waiting for the departure board…" : "No more departures listed"}</div>`}
          </div>
        </div>
        <div class="tile map">
          <div class="chead">
            <div class="label"><ha-icon icon="mdi:map-marker-path"></ha-icon>${t.title ?? "Line"}</div>
            <div class="muted note">
              ${vehicles.length} on the line · ${anyLive ? "tracked where marked live, otherwise" : "positions"} estimated from the timetable
              ${updated ? html` · board ${hm(updated)}` : nothing}
            </div>
          </div>
          ${this.strip(t, vehicles, home)}
          <div class="legend muted">
            <span><i class="veh ab"></i>towards ${t.b.name}</span>
            <span><i class="veh ba"></i>towards ${t.a.name}</span>
          </div>
        </div>
      </div>
    `;
  }

  private strip(t: TransitConfig, vehicles: Vehicle[], home: string) {
    const stops = t.stops;
    const W = 1000;
    const H = 250;
    const y = 150;
    const x = (i: number) => 30 + (i / (stops.length - 1)) * (W - 60);
    return svg`<svg viewBox="0 0 ${W} ${H}" class="svg">
      <line x1="${x(0)}" x2="${x(stops.length - 1)}" y1="${y}" y2="${y}" class="rail" />
      ${stops.map((s, i) => {
        const major = i === 0 || i === stops.length - 1 || s.name === home || s.major;
        return svg`<g class="stop ${major ? "major" : ""} ${s.name === home ? "home" : ""}">
          <circle cx="${x(i)}" cy="${y}" r="${major ? 9 : 5}" />
          <text x="${x(i)}" y="${y - 22}" transform="rotate(-55 ${x(i)} ${y - 22})" text-anchor="start">${s.short ?? s.name}</text>
        </g>`;
      })}
      ${vehicles.map((v) => {
        const vx = 30 + v.frac * (W - 60);
        const vy = v.dir === "ab" ? y + 34 : y + 70;
        return svg`<g class="veh ${v.dir} ${v.live ? "live" : ""}" transform="translate(${vx} ${vy})">
          <title>${v.label}</title>
          <rect x="-20" y="-11" width="40" height="22" rx="7" />
          <path d="${v.dir === "ab" ? "M-6,-5 L4,0 L-6,5 Z" : "M6,-5 L-4,0 L6,5 Z"}" class="arrow" />
        </g>`;
      })}
    </svg>`;
  }

  static styles = [
    PageBase.styles,
    css`
      .top {
        display: grid;
        grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr);
        gap: var(--gap);
        margin-bottom: var(--gap);
      }
      .next .first {
        display: flex;
        align-items: baseline;
        gap: 14px;
        margin-top: 6px;
      }
      .mins {
        font-size: 64px;
        font-weight: 300;
        line-height: 1;
      }
      .next.b .mins {
        font-size: 44px;
      }
      .sub {
        font-size: 18px;
        color: var(--text-2);
      }
      .more {
        display: flex;
        gap: 18px;
        margin-top: 10px;
        font-size: 18px;
        color: var(--text-2);
        font-variant-numeric: tabular-nums;
      }
      .live {
        display: inline-block;
        font-style: normal;
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        padding: 2px 7px;
        border-radius: 999px;
        background: var(--cy);
        color: #04262a;
        margin-left: 6px;
        vertical-align: middle;
      }
      .chead {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        gap: 12px;
        flex-wrap: wrap;
      }
      .note {
        font-size: 13px;
      }
      .svg {
        width: 100%;
        height: auto;
        display: block;
        margin-top: 8px;
      }
      .rail {
        stroke: var(--line);
        stroke-width: 8;
        stroke-linecap: round;
      }
      .stop circle {
        fill: var(--tile);
        stroke: var(--line);
        stroke-width: 4;
      }
      .stop.home circle {
        fill: var(--line);
        stroke: var(--text);
      }
      .stop text {
        font-size: 14px;
        fill: var(--text-2);
        font-family: var(--font);
      }
      .stop.major text {
        fill: var(--text);
        font-weight: 600;
      }
      .veh rect {
        fill: var(--line);
        stroke: var(--text);
        stroke-width: 1.5;
      }
      .veh.ba rect {
        fill: var(--tile);
      }
      .veh .arrow {
        fill: var(--text);
      }
      .veh.live rect {
        fill: var(--cy);
        opacity: 1;
      }
      .legend {
        display: flex;
        gap: 22px;
        font-size: 13px;
        margin-top: 4px;
      }
      .legend .veh {
        display: inline-block;
        width: 22px;
        height: 12px;
        border-radius: 5px;
        background: var(--line);
        border: 1.5px solid var(--text);
        margin-right: 6px;
        vertical-align: middle;
      }
      .legend .veh.ba {
        background: var(--tile);
      }
      @container (max-width: 760px) {
        .top {
          grid-template-columns: 1fr;
        }
      }
    `,
  ];
}

function mins(at: Date) {
  const m = Math.round((at.getTime() - Date.now()) / 60_000);
  if (m <= 0) return "Due";
  return `${m} min`;
}

function hm(d: Date) {
  return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

reg("panel-transit", PageTransit);
