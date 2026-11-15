import type { HomeAssistant, RoomConfig } from "../types";

const STALE = ["off", "idle", "unavailable", "standby", "unknown"];

/** Is this room really playing? Music Assistant can keep a stale "paused"
 *  state after the device itself has stopped, so the device is checked too. */
export function roomState(hass: HomeAssistant, r: RoomConfig): "playing" | "paused" | null {
  const p = hass.states[r.player];
  if (!p || (p.state !== "playing" && p.state !== "paused")) return null;
  const d = r.device ? hass.states[r.device] : undefined;
  if (d && STALE.includes(d.state)) return null;
  return p.state as "playing" | "paused";
}

export function selectedRoomIndex(hass: HomeAssistant, rooms: RoomConfig[], roomEntity?: string, local?: number): number {
  if (roomEntity) {
    const s = hass.states[roomEntity];
    const i = s ? rooms.findIndex((r) => r.name === s.state) : -1;
    if (i >= 0) return i;
  }
  return Math.min(Math.max(local ?? 0, 0), rooms.length - 1);
}

/** The room the Home page should show: the selected room if active, otherwise
 *  the first playing room, otherwise the first paused one. */
export function activeRoom(hass: HomeAssistant, rooms: RoomConfig[], roomEntity?: string): RoomConfig | undefined {
  const sel = rooms[selectedRoomIndex(hass, rooms, roomEntity)];
  if (sel && roomState(hass, sel) === "playing") return sel;
  return (
    rooms.find((r) => roomState(hass, r) === "playing") ??
    (sel && roomState(hass, sel) ? sel : undefined) ??
    rooms.find((r) => roomState(hass, r) === "paused")
  );
}
