import type { HomeAssistant, PanelConfig } from "../types";

export interface Timer {
  id: string;
  name: string;
  left: number;
  total: number;
}

/** Running View Assist timers, soonest first, with seconds remaining. */
export function timersOf(hass: HomeAssistant, sensor: string): Timer[] {
  const raw: any[] = hass.states[sensor]?.attributes.timers ?? [];
  const now = Date.now();
  return raw
    .filter((t) => t.status === "running" && t.expires)
    .map((t) => {
      const exp = new Date(t.expires).getTime();
      const c0 = t.created_at ?? t.created;
      const created = c0 ? new Date(c0).getTime() : NaN;
      const total = Number(t.duration_seconds) || (isNaN(created) ? 0 : (exp - created) / 1000);
      const name = String(t.name || "Timer").replace(/ timer$/i, "");
      return { id: String(t.id), name: name.charAt(0).toUpperCase() + name.slice(1), left: (exp - now) / 1000, total };
    })
    .filter((t) => t.left > -2)
    .sort((a, b) => a.left - b.left);
}

/** "15min", "15 mins", "a minute" → "15 minute timer"; anything else → "<name> timer". */
export function timerLabel(name: string) {
  const n = name.replace(/ timer$/i, "").trim();
  const m = n.match(/^(\d+|an?|one)\s*(s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?)$/i);
  if (!m) return `${n.charAt(0).toUpperCase()}${n.slice(1)} timer`;
  const q = /^(an?|one)$/i.test(m[1]) ? "1" : m[1];
  const u = m[2].toLowerCase();
  const unit = u.startsWith("h") ? "hour" : u.startsWith("s") ? "second" : "minute";
  return `${q} ${unit} timer`;
}

/** Cancel a timer from the panel and say so out loud on the voice satellite, as a voice cancel would. */
export async function cancelTimer(hass: HomeAssistant, config: PanelConfig, id: string, name: string) {
  try {
    await hass.callService("view_assist", "cancel_timer", { timer_id: id });
  } catch (e) {
    console.warn("ha-panel-app: cancel_timer failed", e);
    return;
  }
  const sat = config.voice?.satellite;
  if (sat)
    hass
      .callService("assist_satellite", "announce", { entity_id: sat, message: `${timerLabel(name)} cancelled`, preannounce: false })
      .catch(() => undefined);
}
