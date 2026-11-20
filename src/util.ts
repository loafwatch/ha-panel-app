import type { HassEntity, HomeAssistant } from "./types";

export const esc = (s: unknown) => String(s ?? "");

export const isOn = (e?: HassEntity) => !!e && e.state === "on";

export const isPlaying = (e?: HassEntity) => !!e && (e.state === "playing" || e.state === "paused");

export function fmtTime(d: Date): string {
  return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

export function fmtDay(d: Date): string {
  return d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
}

export function sameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function dayLabel(d: Date): string {
  const today = new Date();
  const tomorrow = new Date(today.getTime() + 86400000);
  if (sameDay(d, today)) return "Today";
  if (sameDay(d, tomorrow)) return "Tomorrow";
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

/** "4:05" or "1:02:03" */
export function fmtCountdown(sec: number): string {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Spoken-style duration: "5 minutes", "1 minute 30 seconds". */
export function fmtDuration(sec: number): string {
  sec = Math.round(sec);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  const parts: string[] = [];
  if (m) parts.push(`${m} minute${m === 1 ? "" : "s"}`);
  if (s || !m) parts.push(`${s} second${s === 1 ? "" : "s"}`);
  return parts.join(" ");
}

export const WEATHER_ICON: Record<string, string> = {
  "clear-night": "mdi:weather-night",
  cloudy: "mdi:weather-cloudy",
  exceptional: "mdi:alert-circle-outline",
  fog: "mdi:weather-fog",
  hail: "mdi:weather-hail",
  lightning: "mdi:weather-lightning",
  "lightning-rainy": "mdi:weather-lightning-rainy",
  partlycloudy: "mdi:weather-partly-cloudy",
  pouring: "mdi:weather-pouring",
  rainy: "mdi:weather-rainy",
  snowy: "mdi:weather-snowy",
  "snowy-rainy": "mdi:weather-snowy-rainy",
  sunny: "mdi:weather-sunny",
  windy: "mdi:weather-windy",
  "windy-variant": "mdi:weather-windy-variant",
};

export const WEATHER_LABEL: Record<string, string> = {
  "clear-night": "Clear",
  partlycloudy: "Partly cloudy",
  "lightning-rainy": "Thunder and rain",
  "snowy-rainy": "Sleet",
  "windy-variant": "Windy",
};

export const weatherLabel = (c?: string) =>
  c ? WEATHER_LABEL[c] ?? c.charAt(0).toUpperCase() + c.slice(1) : "";

/** Track the currently playing position of a media player, in seconds. */
export function mediaPosition(e: HassEntity): number {
  const a = e.attributes;
  let pos = Number(a.media_position) || 0;
  if (e.state === "playing" && a.media_position_updated_at) {
    pos += (Date.now() - new Date(a.media_position_updated_at).getTime()) / 1000;
  }
  const dur = Number(a.media_duration) || 0;
  return dur ? Math.min(pos, dur) : pos;
}

export function fireHaptic() {
  try {
    navigator.vibrate?.(8);
  } catch {
    /* not supported */
  }
}

/** Call a service and swallow errors into the console, so a failed tap never breaks the UI. */
export async function call(hass: HomeAssistant, domain: string, service: string, data?: Record<string, any>) {
  try {
    return await hass.callService(domain, service, data);
  } catch (e) {
    console.warn(`ha-panel-app: ${domain}.${service} failed`, e);
    return undefined;
  }
}

/** Long-press helper: returns handlers for pointer events. */
export function longPress(onTap: () => void, onHold: () => void, ms = 550) {
  let t: number | undefined;
  let fired = false;
  let sx = 0;
  let sy = 0;
  const cancel = () => {
    if (t) window.clearTimeout(t);
    t = undefined;
  };
  return {
    down: (e: PointerEvent) => {
      fired = false;
      sx = e.clientX;
      sy = e.clientY;
      cancel();
      t = window.setTimeout(() => {
        fired = true;
        fireHaptic();
        onHold();
      }, ms);
    },
    move: (e: PointerEvent) => {
      if (Math.abs(e.clientX - sx) > 12 || Math.abs(e.clientY - sy) > 12) cancel();
    },
    up: () => {
      if (t && !fired) {
        cancel();
        onTap();
      }
      cancel();
    },
    cancel,
  };
}

/** Ask the panel not to switch to the photo screensaver while `el` is showing something
 *  the user is watching (lyrics, live TV). Disconnected elements are ignored automatically. */
export function keepAwake(el: HTMLElement, on: boolean) {
  el.dispatchEvent(new CustomEvent("panel-keep-awake", { detail: { on }, bubbles: true, composed: true }));
}
