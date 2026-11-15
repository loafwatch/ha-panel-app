import type { HomeAssistant } from "../types";

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
