import { reg } from "../registry";
import { css, html, nothing, svg } from "lit";
import { state } from "lit/decorators.js";
import { PageBase } from "./base";
import { isDone } from "../data";
import { activeRoom, roomState } from "./music-state";
import { binsInfo } from "./bins";
import { timersOf, cancelTimer } from "./timers-state";
import "../components/weather-fx";
import { calColor } from "./calendar";
import { WEATHER_ICON, call, dayLabel, fmtCountdown, fmtDay, fmtTime, isOn, longPress, weatherLabel } from "../util";

export class PageHome extends PageBase {
  protected usesHub = true;
  protected ticks = true;
  @state() private adding: string | null = null;
  @state() private done = new Set<string>();

  protected watched() {
    const c = this.config;
    return [
      c.weather,
      c.timers?.sensor,
      c.timers?.alarm_switch,
      c.energy?.power,
      c.energy?.rate,
      ...(c.energy?.costs ?? []).map((x) => x.entity),
      ...(c.lights ?? []).map((l) => l.entity),
      ...(c.music?.rooms ?? []).flatMap((r) => [r.player, r.device ?? ""]),
      c.music?.room_entity,
      c.bins?.due_entity,
      c.bins?.out_entity,
    ].filter(Boolean) as string[];
  }

  render() {
    const now = new Date();
    return html`
      <div class="page">
        ${this.savingBanner()}
        ${this.binsBanner()}
        <div class="grid">
          <div class="col">${this.clockTile(now)} ${this.upcomingTile()}</div>
          <div class="col">${this.timersTile()} ${this.lightsTile()} ${this.scenesTile()}</div>
          <div class="col">${this.nowPlayingTile()} ${this.remindersTile(now)} ${this.binsTile()} ${this.energyTile()}</div>
        </div>
      </div>
    `;
  }

  // ---------- tiles ----------

  private clockTile(now: Date) {
    const w = this.st(this.config.weather);
    const today = this.hub.daily[0];
    return html`
      <div class="tile tap clock" @click=${() => this.navigate("weather")}>
        ${w ? html`<panel-weather-fx subtle condition=${w.state} ?dark=${this.dark}></panel-weather-fx>` : nothing}
        <div class="time">${fmtTime(now)}</div>
        <div class="date">${fmtDay(now)}</div>
        ${w
          ? html`<div class="wx">
              <ha-icon icon=${WEATHER_ICON[w.state] ?? "mdi:weather-cloudy"}></ha-icon>
              <span class="temp">${Math.round(w.attributes.temperature)}°</span>
              <span class="muted">${weatherLabel(w.state)}${today
                ? html` · ${Math.round(today.temperature ?? 0)}° / ${Math.round(today.templow ?? 0)}°`
                : nothing}</span>
            </div>`
          : nothing}
      </div>
    `;
  }

  private upcomingTile() {
    const remCal = this.config.reminders?.calendar;
    const evs = this.hub.events.filter((e) => e.end.getTime() > Date.now() && !(e.calendar === remCal && isDone(e.description))).slice(0, 7);
    let last = "";
    return html`
      <div class="tile tap upcoming" @click=${() => this.navigate("calendar")}>
        <div class="label"><ha-icon icon="mdi:calendar-month"></ha-icon>Coming up</div>
        ${evs.length
          ? evs.map((e) => {
              const d = dayLabel(e.start);
              const head = d !== last ? html`<div class="day">${d}</div>` : nothing;
              last = d;
              const live = !e.allDay && e.start.getTime() <= Date.now() && e.end.getTime() > Date.now();
              return html`${head}
                <div class="ev ${live ? "live" : ""}" style="--c:${calColor(this.config, e.calendar)}">
                  <span class="when">${e.allDay ? "All day" : fmtTime(e.start)}</span>
                  <span class="what">${e.summary}</span>
                </div>`;
            })
          : html`<div class="empty">Nothing on the calendar</div>`}
      </div>
    `;
  }

  private timersTile() {
    const t = this.config.timers;
    if (!t) return nothing;
    const list = timersOf(this.hass, t.sensor);
    const ringing = isOn(this.st(t.alarm_switch));
    return html`
      <div class="tile timers ${ringing ? "ringing" : ""}">
        <div class="label tap-label" @click=${() => this.navigate("timers")}>
          <ha-icon icon="mdi:timer-outline"></ha-icon>Timers
          <ha-icon class="chev" icon="mdi:chevron-right"></ha-icon>
        </div>
        ${ringing
          ? html`<button class="btn primary stop" @click=${() => call(this.hass, "switch", "turn_off", { entity_id: t.alarm_switch })}>
              <ha-icon icon="mdi:alarm-off"></ha-icon>Stop alarm
            </button>`
          : nothing}
        ${list.map(
          (x) => html`<div class="timer">
            <div class="tname">${x.name}</div>
            <div class="tleft">${fmtCountdown(x.left)}</div>
            ${t.add_minute_script
              ? html`<button class="btn sm" @click=${() => call(this.hass, "script", "turn_on", { entity_id: t.add_minute_script, variables: { timer_id: x.id, minutes: 1 } })}>+1</button>`
              : nothing}
            <button class="btn sm icon" aria-label="Cancel" @click=${() => cancelTimer(this.hass, this.config, x.id, x.name)}>
              <ha-icon icon="mdi:close"></ha-icon>
            </button>
          </div>`
        )}
        <div class="quick">
          ${(t.quick ?? [1, 3, 5, 10, 15]).map(
            (m) => html`<button class="btn" @click=${() => this.startTimer(m)}>${m}m</button>`
          )}
        </div>
      </div>
    `;
  }

  private startTimer(m: number) {
    const t = this.config.timers!;
    call(this.hass, "view_assist", "set_timer", {
      entity_id: t.sensor,
      type: "Timer",
      name: `${m} min`,
      time: `${m} minute${m === 1 ? "" : "s"}`,
    });
    this.toast(`Timer set for ${m} minute${m === 1 ? "" : "s"}`);
  }

  private lightsTile() {
    const rooms = this.config.lights ?? [];
    if (!rooms.length) return nothing;
    return html`
      <div class="tile lights">
        <div class="label tap-label" @click=${() => this.navigate("lights")}>
          <ha-icon icon="mdi:lightbulb-group-outline"></ha-icon>Lights
          <ha-icon class="chev" icon="mdi:chevron-right"></ha-icon>
        </div>
        <div class="lgrid">
          ${rooms.map((r) => {
            const e = this.st(r.entity);
            const on = isOn(e);
            const pct = on && e?.attributes.brightness ? Math.round((e.attributes.brightness / 255) * 100) : 0;
            const lp = longPress(
              () => call(this.hass, "light", "toggle", { entity_id: r.entity }),
              () => this.navigate("lights")
            );
            return html`<div
              class="lt ${on ? "on" : ""}"
              @pointerdown=${lp.down}
              @pointermove=${lp.move}
              @pointerup=${lp.up}
              @pointerleave=${lp.cancel}
              @pointercancel=${lp.cancel}
            >
              <ha-icon icon=${r.icon ?? (on ? "mdi:lightbulb-on" : "mdi:lightbulb-outline")}></ha-icon>
              <div class="ln">${r.name}</div>
              <div class="ls">${!e ? "Unavailable" : on ? (pct ? `${pct}%` : "On") : "Off"}</div>
            </div>`;
          })}
        </div>
      </div>
    `;
  }

  private scenesTile() {
    const sc = this.config.scenes ?? [];
    if (!sc.length) return nothing;
    return html`
      <div class="tile scenes">
        <div class="label"><ha-icon icon="mdi:palette-outline"></ha-icon>Scenes</div>
        <div class="srow">
          ${sc.map(
            (s) => html`<button class="scene" @click=${() => {
              call(this.hass, "scene", "turn_on", { entity_id: s.entity });
              this.toast(s.name);
            }}>
              <ha-icon icon=${s.icon ?? "mdi:palette"}></ha-icon><span>${s.name}</span>
            </button>`
          )}
        </div>
      </div>
    `;
  }

  private nowPlayingTile() {
    const m = this.config.music;
    if (!m?.rooms.length) return nothing;
    const act = activeRoom(this.hass, m.rooms, m.room_entity);
    const p = act ? this.st(act.player) : undefined;
    const a = p?.attributes ?? {};
    return html`
      <div class="tile tap np" @click=${() => this.navigate("music")}>
        ${p
          ? html`
              <div class="npart" style=${a.entity_picture ? `background-image:url("${a.entity_picture}")` : ""}>
                ${a.entity_picture ? nothing : html`<ha-icon icon="mdi:music"></ha-icon>`}
              </div>
              <div class="npinfo">
                <div class="nptitle">${a.media_title ?? "Playing"}</div>
                <div class="npartist muted">${a.media_artist ?? ""}</div>
                <div class="nproom">${p.state === "paused" ? "Paused" : "Playing"} · ${act!.name}</div>
                <div class="npctl" @click=${(e: Event) => e.stopPropagation()}>
                  <button class="round" @click=${() => call(this.hass, "media_player", "media_previous_track", { entity_id: act!.player })}>
                    <ha-icon icon="mdi:skip-previous"></ha-icon>
                  </button>
                  <button class="round main" @click=${() => call(this.hass, "media_player", "media_play_pause", { entity_id: act!.player })}>
                    <ha-icon icon=${p.state === "playing" ? "mdi:pause" : "mdi:play"}></ha-icon>
                  </button>
                  <button class="round" @click=${() => call(this.hass, "media_player", "media_next_track", { entity_id: act!.player })}>
                    <ha-icon icon="mdi:skip-next"></ha-icon>
                  </button>
                </div>
              </div>
            `
          : html`<div class="npart idle"><ha-icon icon="mdi:music"></ha-icon></div>
              <div class="npinfo">
                <div class="nptitle">Nothing playing</div>
                <div class="npartist muted">Tap to pick some music</div>
              </div>`}
      </div>
    `;
  }

  /** Family reminders: today's and missed ones to tick off, then the next few coming up. */
  private remindersTile(now: Date) {
    const cal = this.config.reminders?.calendar;
    if (!cal) return nothing;
    const open = this.hub.reminders.filter((r) => !r.done);
    const later = this.hub.events
      .filter((e) => e.calendar === cal && e.start.getTime() > now.getTime() && !isDone(e.description))
      .filter((e) => !open.some((r) => r.summary === e.summary))
      // a repeating reminder shows once, at its next occurrence
      .filter((e, i, all) => all.findIndex((x) => x.summary === e.summary) === i)
      .slice(0, Math.max(0, 3 - open.length));
    return html`<div class="tile rems">
      <div class="label tap-label" @click=${() => this.navigate("calendar")}><ha-icon icon="mdi:bell-outline"></ha-icon>Reminders</div>
      ${open.map((r) => {
        const today = r.start.toDateString() === now.toDateString();
        return html`<div class="rem ${today ? "" : "late"}">
          <span class="rt"><b>${r.summary}</b><span>${today ? (r.allDay ? "Today" : "Today " + fmtTime(r.start)) : dayLabel(r.start)}</span></span>
          <button class="tick" aria-label="Mark ${r.summary} done" @click=${() => {
            this.hub.markReminderDone(r);
            this.toast(`Done: ${r.summary}`);
          }}><ha-icon icon="mdi:check"></ha-icon></button>
        </div>`;
      })}
      ${later.map(
        (e) => html`<div class="rem soon"><span class="rt"><b>${e.summary}</b><span>${dayLabel(e.start)}${e.allDay ? "" : " " + fmtTime(e.start)}</span></span></div>`,
      )}
      ${!open.length && !later.length ? html`<div class="empty">No reminders coming up</div>` : nothing}
    </div>`;
  }

  /** Next bin collection, by what goes in it, in the bin's colour. */
  private binsTile() {
    const b = binsInfo(this.hass, this.config);
    if (!b?.next) return nothing;
    const n = b.next;
    const rest = b.upcoming.slice(1, 3);
    return html`<div class="tile binst" style="--bin:${n.color ?? "var(--accent)"}">
      <div class="label"><ha-icon icon="mdi:trash-can-outline"></ha-icon>Next bin</div>
      <div class="bnext"><i></i><b>${n.name}</b><span>${dayLabel(n.date)}</span></div>
      ${rest.map((x) => html`<div class="bmore" style="--bin:${x.color ?? "var(--accent)"}"><i></i>${x.name}<span>${dayLabel(x.date)}</span></div>`)}
    </div>`;
  }

  private listsTile() {
    const lists = this.config.todo_lists ?? [];
    if (!lists.length) return nothing;
    return html`${lists.map((l) => {
      const items = (this.hub.todos[l.entity] ?? []).filter((i) => i.status === "needs_action");
      return html`
        <div class="tile list">
          <div class="label"><ha-icon icon=${l.icon ?? "mdi:format-list-checks"}></ha-icon>${l.name}
            <span class="count">${items.length || ""}</span></div>
          ${items.slice(0, 6).map(
            (i) => html`<div class="item ${this.done.has(i.uid) ? "done" : ""}" @click=${() => this.complete(l.entity, i.uid)}>
              <span class="box"><ha-icon icon="mdi:check"></ha-icon></span><span>${i.summary}</span>
            </div>`
          )}
          ${items.length > 6 ? html`<div class="muted more">+${items.length - 6} more</div>` : nothing}
          ${!items.length && this.adding !== l.entity ? html`<div class="empty">All done</div>` : nothing}
          ${this.adding === l.entity
            ? html`<form class="add" @submit=${(e: Event) => this.add(e, l.entity)}>
                <input id="add-${l.entity}" placeholder="Add an item…" autocomplete="off" enterkeyhint="done" />
                <button class="btn primary" type="submit">Add</button>
              </form>`
            : html`<button class="addbtn" @click=${() => this.openAdd(l.entity)}><ha-icon icon="mdi:plus"></ha-icon>Add</button>`}
        </div>
      `;
    })}`;
  }

  private async openAdd(entity: string) {
    this.adding = entity;
    await this.updateComplete;
    (this.renderRoot.querySelector(`#add-${CSS.escape(entity)}`) as HTMLInputElement | null)?.focus();
  }

  private add(e: Event, entity: string) {
    e.preventDefault();
    const input = this.renderRoot.querySelector(`#add-${CSS.escape(entity)}`) as HTMLInputElement | null;
    const v = input?.value.trim();
    if (v) call(this.hass, "todo", "add_item", { entity_id: entity, item: v });
    this.adding = null;
  }

  private complete(entity: string, uid: string) {
    this.done = new Set(this.done).add(uid);
    window.setTimeout(() => {
      call(this.hass, "todo", "update_item", { entity_id: entity, item: uid, status: "completed" });
      const s = new Set(this.done);
      s.delete(uid);
      this.done = s;
    }, 600);
  }

  private energyTile() {
    const en = this.config.energy;
    if (!en) return nothing;
    const p = this.st(en.power);
    const rate = this.st(en.rate);
    const costs = (en.costs ?? []).map((c) => ({ name: c.name, v: Number(this.st(c.entity)?.state) || 0 }));
    const total = costs.reduce((s, c) => s + c.v, 0);
    const w = Number(p?.state) || 0;
    return html`
      <div class="tile tap energy" @click=${() => this.navigate("energy")}>
        <div class="label"><ha-icon icon="mdi:lightning-bolt-outline"></ha-icon>Energy</div>
        <div class="erow">
          <div><div class="big">${w >= 1000 ? (w / 1000).toFixed(2) + " kW" : Math.round(w) + " W"}</div>
            <div class="muted">using now${rate ? ` · ${(Number(rate.state) * 100).toFixed(1)}p/kWh` : ""}</div></div>
          ${costs.length
            ? html`<div class="right"><div class="big">£${total.toFixed(2)}</div>
                <div class="muted">today · ${costs.map((c) => `${c.name} £${c.v.toFixed(2)}`).join(" · ")}</div></div>`
            : nothing}
        </div>
        ${powerWave(w)}
        ${(() => {
          const running = (en.devices ?? [])
            .map((d) => ({ d, w: Number(this.st(d.power)?.state) }))
            .filter((x) => x.w >= 5 && !/server/i.test(x.d.name))
            .sort((p, q) => q.w - p.w)
            .slice(0, 3);
          return running.length
            ? html`<div class="devs">
                ${running.map(
                  ({ d, w: dw }) => html`<span class="dev on"><ha-icon icon=${d.icon ?? "mdi:power-plug-outline"}></ha-icon>${d.name}
                    <b>${dw >= 1000 ? (dw / 1000).toFixed(1) + " kW" : Math.round(dw) + " W"}</b></span>`,
                )}
              </div>`
            : nothing;
        })()}
      </div>
    `;
  }

  /** Energy saving session today: a heads-up before it starts and a glowing banner during it. */
  private savingBanner() {
    const now = new Date();
    const s = this.hub.savings.find((e) => e.end > now && e.start.toDateString() === now.toDateString());
    if (!s) return nothing;
    const live = s.start <= now;
    return html`
      <div class="saving tile ${live ? "live" : ""}">
        <ha-icon icon=${live ? "mdi:lightning-bolt-circle" : "mdi:leaf"}></ha-icon>
        <div class="btxt">
          ${live
            ? html`<b>Saving session on now</b> until ${fmtTime(s.end)} · keep the big appliances off`
            : html`<b>Saving session today</b> ${fmtTime(s.start)}–${fmtTime(s.end)} · run the dishwasher or dryer before or after`}
        </div>
      </div>
    `;
  }

  private binsBanner() {
    const b = binsInfo(this.hass, this.config);
    if (!b || !b.due) return nothing;
    return html`
      <div class="bins tile" style="--bin:${b.next?.color ?? "var(--accent)"}">
        <ha-icon icon="mdi:trash-can-outline"></ha-icon>
        <div class="btxt"><b>${b.next?.name ?? "Bin"}</b> goes out tonight · collected ${b.next ? dayLabel(b.next.date).toLowerCase() : "tomorrow"}</div>
        ${this.config.bins?.out_entity
          ? html`<button class="btn primary" @click=${() => call(this.hass, "input_boolean", "turn_on", { entity_id: this.config.bins!.out_entity })}>It's out</button>`
          : nothing}
      </div>
    `;
  }

  static styles = [
    PageBase.styles,
    css`
      .grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: var(--gap);
        align-items: start;
      }
      @container (max-width: 1000px) {
        .grid {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
        .col:nth-child(3) {
          grid-column: 1 / -1;
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          align-items: start;
        }
      }
      @container (max-width: 640px) {
        .grid,
        .col:nth-child(3) {
          grid-template-columns: 1fr;
        }
      }
      .col {
        display: flex;
        flex-direction: column;
        gap: var(--gap);
        min-width: 0;
      }
      .tap-label {
        cursor: pointer;
      }
      .chev {
        margin-left: auto;
        --mdc-icon-size: 20px;
        color: var(--text-2);
      }
      /* clock */
      .clock > :not(panel-weather-fx) {
        position: relative;
        z-index: 1;
      }
      .clock .time {
        font-size: 76px;
        font-weight: 300;
        line-height: 1;
        letter-spacing: -0.02em;
      }
      .clock .date {
        margin-top: 8px;
        font-size: 17px;
        color: var(--text-2);
      }
      .wx {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-top: 16px;
        font-size: 15px;
      }
      .wx ha-icon {
        --mdc-icon-size: 34px;
        color: var(--accent);
      }
      .wx .temp {
        font-size: 28px;
        font-weight: 600;
      }
      /* upcoming */
      .day {
        font-size: 13px;
        font-weight: 700;
        color: var(--text-2);
        margin: 12px 0 4px;
      }
      .day:first-of-type {
        margin-top: 0;
      }
      .ev {
        display: flex;
        gap: 12px;
        padding: 7px 0 7px 12px;
        margin: 4px 0;
        font-size: 15px;
        line-height: 1.35;
        border-left: 4px solid var(--c, var(--accent));
        border-radius: 4px;
        background: var(--tile-2);
      }
      .ev .when {
        flex: 0 0 62px;
        color: var(--text-2);
        font-variant-numeric: tabular-nums;
      }
      .ev.live .when {
        color: var(--accent);
        font-weight: 700;
      }
      .ev .what {
        min-width: 0;
      }
      /* timers */
      .timer {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 6px 0;
      }
      .tname {
        flex: 1;
        min-width: 0;
        font-weight: 600;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .tleft {
        font-size: 24px;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
        color: var(--accent);
      }
      .btn.sm {
        padding: 6px 12px;
        font-size: 14px;
      }
      .btn.icon {
        padding: 6px;
      }
      .quick {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        margin-top: 8px;
      }
      .quick .btn {
        flex: 1;
        min-width: 52px;
        padding: 12px 0;
      }
      .timers.ringing {
        animation: ring 1s ease-in-out infinite;
      }
      @keyframes ring {
        50% {
          box-shadow: 0 0 0 3px var(--pk), 0 0 24px var(--pk);
        }
      }
      .stop {
        width: 100%;
        margin-bottom: 8px;
        padding: 14px;
      }
      /* lights */
      .lgrid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 10px;
      }
      .lt {
        border-radius: var(--radius-sm);
        padding: 12px 14px;
        background: var(--tile-2);
        border: 1px solid var(--line);
        cursor: pointer;
        user-select: none;
        -webkit-user-select: none;
        touch-action: manipulation;
        transition: border-color 0.2s, box-shadow 0.2s;
      }
      .lt ha-icon {
        color: var(--text-2);
      }
      .lt.on {
        border-color: var(--cy);
        box-shadow: 0 0 12px rgba(0, 200, 212, 0.25);
      }
      .lt.on ha-icon {
        color: var(--cy);
      }
      .ln {
        margin-top: 8px;
        font-weight: 600;
        font-size: 15px;
      }
      .ls {
        font-size: 13px;
        color: var(--text-2);
      }
      .lt.on .ls {
        color: var(--cy);
        font-weight: 600;
      }
      /* scenes */
      .srow {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(70px, 1fr));
        gap: 8px;
      }
      .scene {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 6px;
        padding: 12px 4px;
        border-radius: var(--radius-sm);
        border: 1px solid var(--line);
        background: var(--tile-2);
        color: var(--text);
        font: 600 13px var(--font);
        cursor: pointer;
      }
      .scene ha-icon {
        color: var(--accent);
      }
      .scene:active {
        transform: scale(0.95);
      }
      /* now playing */
      .np {
        display: flex;
        gap: 16px;
        align-items: center;
      }
      .npart {
        flex: 0 0 104px;
        height: 104px;
        border-radius: 16px;
        background: var(--grad) center/cover no-repeat;
        display: flex;
        align-items: center;
        justify-content: center;
        color: #fff;
      }
      .npart ha-icon {
        --mdc-icon-size: 40px;
      }
      .npart.idle {
        opacity: 0.7;
      }
      .npinfo {
        min-width: 0;
        flex: 1;
      }
      .nptitle {
        font-size: 17px;
        font-weight: 700;
        line-height: 1.35;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .npartist {
        font-size: 14px;
        line-height: 1.4;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .nproom {
        font-size: 12px;
        color: var(--accent);
        font-weight: 600;
        margin-top: 2px;
      }
      .npctl {
        display: flex;
        gap: 10px;
        margin-top: 8px;
      }
      .round {
        width: 44px;
        height: 44px;
        border-radius: 50%;
        border: 1px solid var(--line);
        background: var(--tile-2);
        color: var(--text);
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
      }
      .round.main {
        background: var(--grad);
        border: none;
        color: #fff;
      }
      /* reminders */
      .rem {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 8px 0;
        border-bottom: 1px solid var(--line);
      }
      .rem:last-child {
        border-bottom: 0;
      }
      .rt {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
      }
      .rt b {
        font-size: 15px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .rt span {
        font-size: 13px;
        color: var(--text-2);
      }
      .rem.late .rt span {
        color: #ffb547;
      }
      .rem.soon b {
        font-weight: 500;
      }
      .rem .tick {
        flex: none;
        display: grid;
        place-items: center;
        width: 38px;
        height: 38px;
        border-radius: 50%;
        border: 2px solid #3ddc84;
        background: none;
        color: #3ddc84;
        cursor: pointer;
        --mdc-icon-size: 20px;
      }
      /* bins */
      .bnext {
        display: flex;
        align-items: center;
        gap: 10px;
        font-size: 18px;
      }
      .bnext span,
      .bmore span {
        margin-left: auto;
        color: var(--text-2);
        font-size: 14px;
      }
      .bnext i,
      .bmore i {
        flex: none;
        width: 16px;
        height: 16px;
        border-radius: 50%;
        background: var(--bin);
        box-shadow: 0 0 10px var(--bin);
      }
      .bmore i {
        width: 10px;
        height: 10px;
        box-shadow: none;
      }
      .bmore {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-top: 8px;
        font-size: 14px;
      }
      /* lists */
      .count {
        margin-left: auto;
        color: var(--text-2);
        font-weight: 600;
      }
      .item {
        display: flex;
        gap: 12px;
        align-items: center;
        padding: 8px 0;
        font-size: 15px;
        cursor: pointer;
        transition: opacity 0.4s;
      }
      .box {
        flex: 0 0 24px;
        height: 24px;
        border-radius: 8px;
        border: 2px solid var(--line);
        display: flex;
        align-items: center;
        justify-content: center;
        color: transparent;
      }
      .box ha-icon {
        --mdc-icon-size: 16px;
      }
      .item.done {
        opacity: 0.4;
        text-decoration: line-through;
      }
      .item.done .box {
        background: var(--accent);
        border-color: var(--accent);
        color: #fff;
      }
      .more {
        font-size: 13px;
      }
      .addbtn {
        margin-top: 6px;
        display: flex;
        align-items: center;
        gap: 6px;
        background: none;
        border: none;
        color: var(--accent);
        font: 600 14px var(--font);
        padding: 6px 0;
        cursor: pointer;
      }
      .add {
        display: flex;
        gap: 8px;
        margin-top: 8px;
      }
      .add input {
        flex: 1;
        min-width: 0;
        border-radius: 999px;
        border: 1px solid var(--line);
        background: var(--tile-2);
        color: var(--text);
        padding: 10px 16px;
        font: 15px var(--font);
        outline: none;
      }
      .add input:focus {
        border-color: var(--accent);
      }
      /* energy */
      .erow {
        display: flex;
        justify-content: space-between;
        gap: 12px;
      }
      .big {
        font-size: 26px;
        font-weight: 600;
      }
      .right {
        text-align: right;
      }
      .energy .muted {
        font-size: 12px;
        line-height: 1.5;
      }
      .devs {
        display: flex;
        flex-wrap: wrap;
        gap: 6px 14px;
        margin-top: 6px;
        font-size: 13px;
        color: var(--text-2);
      }
      .dev {
        display: inline-flex;
        align-items: center;
        gap: 5px;
      }
      .dev ha-icon {
        --mdc-icon-size: 16px;
      }
      .dev b {
        color: var(--text);
        font-weight: 600;
      }
      .dev.on ha-icon {
        color: var(--cy);
      }
      .wave {
        display: block;
        width: 100%;
        height: 44px;
        margin-top: 10px;
        overflow: hidden;
        color: var(--cy);
      }
      .wave .glow {
        filter: drop-shadow(0 0 3px currentColor);
      }
      .meter span {
        display: block;
        height: 100%;
        background: linear-gradient(90deg, var(--cy), var(--pk));
        transition: width 0.6s;
      }
      /* energy saving session */
      .saving {
        display: flex;
        align-items: center;
        gap: 14px;
        margin-bottom: var(--gap);
        border: 2px solid var(--cy);
      }
      .saving ha-icon {
        --mdc-icon-size: 30px;
        color: var(--cy);
      }
      .saving.live {
        animation: savepulse 2s ease-in-out infinite;
      }
      @keyframes savepulse {
        50% {
          box-shadow: 0 0 0 3px var(--cy), 0 0 22px var(--cy);
        }
      }
      /* bins */
      .bins {
        display: flex;
        align-items: center;
        gap: 14px;
        margin-bottom: var(--gap);
        border: 2px solid var(--bin);
        animation: binpulse 2s ease-in-out infinite;
      }
      .bins ha-icon {
        --mdc-icon-size: 30px;
        color: var(--bin);
      }
      .btxt {
        flex: 1;
        font-size: 16px;
      }
      @keyframes binpulse {
        50% {
          box-shadow: 0 0 0 3px var(--bin), 0 0 22px var(--bin);
        }
      }
    `,
  ];
}

/** A scrolling sine wave whose height and speed follow the current power draw. */
function powerWave(watts: number) {
  const f = Math.min(Math.max(0, watts), 4000) / 4000;
  const amp = 3 + f * 13;
  const dur = 2.6 - f * 1.9;
  const P = 60;
  const mk = (a: number, ph: number) => {
    let d = "";
    for (let x = 0; x <= 360; x += 3) {
      const y = 20 + a * (0.75 * Math.sin((2 * Math.PI * (x + ph)) / P) + 0.25 * Math.sin((4 * Math.PI * (x + ph)) / P));
      d += (x ? "L" : "M") + x + " " + y.toFixed(2);
    }
    return d;
  };
  return svg`<svg class="wave" viewBox="0 0 300 40" preserveAspectRatio="none">
    <g>
      <path d=${mk(amp * 0.55, 15)} fill="none" stroke="currentColor" stroke-opacity="0.35" stroke-width="1.5" />
      <animateTransform attributeName="transform" type="translate" from="0 0" to="-${P} 0" dur="${(dur * 1.6).toFixed(2)}s" repeatCount="indefinite" />
    </g>
    <g class="glow">
      <path d=${mk(amp, 0)} fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" />
      <animateTransform attributeName="transform" type="translate" from="0 0" to="-${P} 0" dur="${dur.toFixed(2)}s" repeatCount="indefinite" />
    </g>
  </svg>`;
}

reg("panel-home", PageHome);
