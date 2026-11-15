import type { HomeAssistant, PanelConfig } from "../types";

export interface BinInfo {
  due: boolean;
  next?: { name: string; date: Date; color?: string };
  upcoming: { name: string; date: Date; color?: string }[];
}

/** Next collections from Waste Collection Schedule sensors (date keys in attributes). */
export function binsInfo(hass: HomeAssistant, config: PanelConfig): BinInfo | undefined {
  const b = config.bins;
  if (!b) return undefined;
  const today = new Date(new Date().setHours(0, 0, 0, 0)).getTime();
  const upcoming = b.collections
    .map((c) => {
      const attrs = hass.states[c.entity]?.attributes ?? {};
      const dates = Object.keys(attrs)
        .filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k))
        .map((k) => new Date(k + "T00:00:00"))
        .filter((d) => d.getTime() >= today)
        .sort((x, y) => x.getTime() - y.getTime());
      return dates[0] ? { name: c.name, date: dates[0], color: c.color } : undefined;
    })
    .filter((x): x is NonNullable<typeof x> => !!x)
    .sort((x, y) => x.date.getTime() - y.date.getTime());
  const due = !!b.due_entity && hass.states[b.due_entity]?.state === "on" && !(b.out_entity && hass.states[b.out_entity]?.state === "on");
  return { due, next: upcoming[0], upcoming };
}
