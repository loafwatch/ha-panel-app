import { reg } from "../registry";
import { css, html, nothing, svg } from "lit";
import { PageBase } from "./base";
import { fmtDay, fmtTime } from "../util";
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
  /** Estimated arrival at the far terminus (ms). */
  eta?: number;
}

export class PageTransit extends PageBase {
  protected ticks = true;

  protected watched() {
    const t = this.config.transit;
    return [t?.a.sensor, t?.b.sensor, t?.approach?.sensor].filter(Boolean) as string[];
  }

  /** Parse a board's departures into dates (today, or tomorrow if the time has passed by hours). */
  private deps(sensor: string, stop?: string): Dep[] {
    const st = this.st(sensor);
    const rows = (st?.attributes.departures ?? []) as TransitDeparture[];
    const now = new Date();
    const out: Dep[] = [];
    const here = (stop ?? "").trim().toLowerCase();
    for (const r of rows) {
      // a terminus board also lists trams terminating there ("to <this stop>"); those aren't departures
      if (here && String(r.to ?? "").trim().toLowerCase() === here) continue;
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
    // Boards can list the same departure more than once (e.g. an "all" and a per-line tab).
    const seen = new Set<string>();
    return out
      .sort((x, y) => x.at.getTime() - y.at.getTime())
      .filter((d) => {
        const k = d.at.getTime() + "|" + d.to;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
  }

  /** Vehicles on the line in one direction, from upcoming departures plus the
   *  headway worked backwards to cover trams that have already left. */
  private vehicles(dir: "ab" | "ba", deps: Dep[], includeNotYetLeft = false): Vehicle[] {
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
      if (elapsed > total + 1) continue;
      if (elapsed < 0) {
        if (includeNotYetLeft) out.push({ dir, frac: dir === "ab" ? 0 : 1, stop: "", label: "", live: s.live, eta: s.at + total * 60_000 });
        continue;
      }
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
        eta: s.at + total * 60_000,
      });
    }
    return out;
  }

  render() {
    const t = this.config.transit;
    if (!t) return html`<div class="page"><div class="empty">No transit line configured.</div></div>`;
    const depsA = this.deps(t.a.sensor, t.a.name);
    const depsB = this.deps(t.b.sensor, t.b.name);
    const now = Date.now();
    const nextA = depsA.filter((d) => d.at.getTime() >= now - 60_000).slice(0, 4);
    const nextB = depsB.filter((d) => d.at.getTime() >= now - 60_000).slice(0, 3);
    const vehicles = [...this.vehicles("ab", depsA), ...this.vehicles("ba", depsB)];
    const stA = this.st(t.a.sensor);
    const updated = stA?.attributes.updated ? new Date(stA.attributes.updated) : undefined;
    const stale = !updated || now - updated.getTime() > 15 * 60_000;
    const anyLive = depsA.some((d) => d.live) || depsB.some((d) => d.live);
    const home = t.home ?? t.a.name;
    const walk = t.walk_min ?? 0;
    // estimated time the next tram reaches A: the matching run from B plus the run time
    const runBA = t.stops[0].ba;
    const lay = t.layover_min;
    const ap = t.approach;
    const apDeps = ap ? this.deps(ap.sensor).filter((d) => d.to.trim().toLowerCase() === t.a.name.trim().toLowerCase()) : [];
    /** arrival at A of the vehicle that forms departure `dep`: the latest approach departure that gets in before it */
    const formsFrom = (dep: Dep) => {
      if (!ap) return undefined;
      const c = apDeps.filter((x) => x.at.getTime() + ap.run_min * 60_000 <= dep.at.getTime() - 60_000).pop();
      return c ? { left: c.at, arr: new Date(c.at.getTime() + ap.run_min * 60_000), live: c.live } : undefined;
    };
    const inbound = (
      ap
        ? apDeps.map((d) => ({ dir: "ba" as const, frac: 1, stop: "", label: "", live: d.live, eta: d.at.getTime() + ap.run_min * 60_000, left: d.at.getTime() }))
        : lay != null
        ? depsA.map((d) => ({ dir: "ba" as const, frac: 1, stop: "", label: "", live: d.live, eta: d.at.getTime() - lay * 60_000 }))
        : this.vehicles("ba", depsB, true)
    )
      .filter((v) => v.eta != null && v.eta >= now - 60_000)
      .sort((p, q) => p.eta! - q.eta!);
    const arrivals = inbound;
    const arrivalsA = inbound.map((v) => v.eta!);
    const dwell = (dep: Dep) => {
      const arr = arrivalsA.filter((x) => x <= dep.at.getTime() - 60_000 && x > dep.at.getTime() - 25 * 60_000).sort((p, q) => q - p)[0];
      return arr ? new Date(arr) : undefined;
    };
    const catchable = walk ? nextA.find((d) => d.at.getTime() - now >= walk * 60_000) : undefined;
    const first = nextA[0];
    const firstArr = first ? dwell(first) : undefined;
    return html`
      <div class="page" style="--line:${t.color ?? "var(--accent)"}">
        <div class="top">
          <div class="tile next">
            <div class="label"><ha-icon icon=${t.icon ?? "mdi:tram"}></ha-icon>Next tram from ${t.a.name}</div>
            ${first
              ? html`<div class="first">
                    <span class="mins">${hm(first.at)}</span>
                    <span class="sub"><b>leaves in ${minsWord(first.at)}</b><span>to ${first.to}${first.live ? html` <i class="live">live</i>` : nothing}</span></span>
                  </div>
                  <div class="muted plat">
                    ${ap && formsFrom(first)
                      ? html`On the platform from about ${hm(formsFrom(first)!.arr)} · leaves ${ap.name} ${hm(formsFrom(first)!.left)}`
                      : ap && depsA.length && apDeps.length
                      ? html`Already past ${ap.name}, so it should be waiting at the platform now`
                      : lay != null
                      ? html`On the platform from about ${hm(new Date(first.at.getTime() - lay * 60_000))} (usually waits ${lay} min)`
                      : firstArr
                        ? html`Due on the platform from about ${hm(firstArr)} (${Math.max(0, Math.round((first.at.getTime() - firstArr.getTime()) / 60_000))} min turnaround, estimated)`
                        : html`Platform time unknown until the previous tram's run can be matched`}
                  </div>
                  ${walk
                    ? catchable
                      ? html`<div class="verdict ${catchable === first ? "go" : "wait"}">
                          <ha-icon icon=${catchable === first ? "mdi:walk" : "mdi:clock-alert-outline"}></ha-icon>
                          <span>${catchable === first
                            ? html`Leave now and you'll make the ${hm(first.at)} with ${Math.round((first.at.getTime() - now) / 60_000) - walk} min to spare`
                            : html`Too late for the ${hm(first.at)}. Set off by <b>${hm(new Date(catchable.at.getTime() - walk * 60_000))}</b> for the ${hm(catchable.at)}`}</span>
                        </div>`
                      : html`<div class="verdict wait"><ha-icon icon="mdi:clock-alert-outline"></ha-icon><span>None of the listed trams can be reached on foot in ${walk} min</span></div>`
                    : nothing}
                  <div class="more">Then ${nextA.slice(1).map((d) => html`<span>${hm(d.at)}${d.live ? html`<i class="live">live</i>` : nothing}</span>`)}</div>`
              : html`<div class="empty">${stale ? "Waiting for the departure board…" : "No more departures listed"}</div>`}
          </div>
          <div class="tile clock">
            <div class="now">${fmtTime(new Date())}</div>
            <div class="muted">${fmtDay(new Date())}</div>
            ${walk ? html`<div class="muted walk"><ha-icon icon="mdi:walk"></ha-icon>${walk} min walk to ${t.a.name}</div>` : nothing}
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
          <div class="mapwrap">${this.strip(t, vehicles, home)}</div>
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
    // leave room on the right for the last stop's rotated label
    const x = (i: number) => 30 + (i / (stops.length - 1)) * (W - 130);
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
        const vx = 30 + v.frac * (W - 130);
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
        grid-template-columns: minmax(0, 2fr) minmax(220px, 1fr);
        gap: var(--gap);
        margin-bottom: var(--gap);
      }
      .next .first {
        display: flex;
        align-items: center;
        gap: 16px;
        margin-top: 8px;
      }
      /* one time style for all three cards */
      .mins,
      .now {
        font-size: 60px;
        font-weight: 400;
        line-height: 1;
        letter-spacing: -0.01em;
        font-variant-numeric: tabular-nums;
      }
      .sub {
        display: flex;
        flex-direction: column;
        gap: 2px;
        font-size: 16px;
        color: var(--text-2);
        line-height: 1.25;
      }
      .sub b {
        color: var(--text);
        font-size: 19px;
        font-weight: 600;
      }
      .plat {
        font-size: 13px;
        margin-top: 8px;
      }
      .verdict {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-top: 12px;
        padding: 10px 14px;
        border-radius: var(--radius-sm);
        font-size: 16px;
        font-weight: 600;
        background: var(--tile-2);
        border-left: 4px solid var(--cy);
      }
      .verdict.go {
        border-left-color: #3ddc84;
      }
      .verdict.wait {
        border-left-color: var(--pk);
      }
      .verdict ha-icon {
        flex: none;
        color: var(--accent);
      }
      .verdict span {
        display: block;
        min-width: 0;
        line-height: 1.35;
      }
      .verdict b {
        font-size: 1.1em;
      }

      .clock {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        text-align: center;
      }

      .walk {
        margin-top: 12px;
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 14px;
      }
      .walk ha-icon {
        --mdc-icon-size: 18px;
      }
      .more {
        display: flex;
        gap: 14px;
        margin-top: 10px;
        font-size: 16px;
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
      @container (max-width: 900px) {
        .top {
          grid-template-columns: 1fr 1fr;
        }
      }
      @container (max-width: 640px) {
        .top {
          grid-template-columns: 1fr;
        }
        /* the line map keeps its proportions and scrolls sideways */
        .mapwrap {
          overflow-x: auto;
          scrollbar-width: none;
          -webkit-overflow-scrolling: touch;
        }
        .mapwrap .svg {
          min-width: 900px;
        }
      }
      @container (max-width: 900px) {
        .clock {
          order: -1;
          grid-column: 1 / -1;
          padding: 10px;
        }
        .now {
          font-size: 40px;
        }
      }
    `,
  ];
}

function minsWord(at: Date) {
  const m = Math.round((at.getTime() - Date.now()) / 60_000);
  if (m <= 0) return "under a minute";
  return `${m} min`;
}

function hm(d: Date) {
  return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

reg("panel-transit", PageTransit);
