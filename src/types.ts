// Home Assistant types (minimal) and the panel's runtime config schema.
// Every install-specific value lives in the user's own configuration.yaml
// (`panel_custom` -> `config:`). Nothing household-specific belongs in code.

export interface HassEntity {
  entity_id: string;
  state: string;
  attributes: Record<string, any>;
  last_changed: string;
  last_updated: string;
}

export interface HomeAssistant {
  states: Record<string, HassEntity>;
  themes: { darkMode?: boolean };
  language: string;
  locale?: { time_format?: string };
  user?: { name?: string; is_admin?: boolean };
  connection: {
    subscribeMessage<T = any>(cb: (msg: T) => void, msg: Record<string, any>): Promise<() => void>;
  };
  callService(domain: string, service: string, data?: Record<string, any>, target?: Record<string, any>): Promise<any>;
  callWS<T = any>(msg: Record<string, any>): Promise<T>;
  hassUrl(path?: string): string;
}

export interface NamedEntity {
  name: string;
  entity: string;
  icon?: string;
}

export interface RoomConfig {
  name: string;
  /** Music Assistant player entity for the room. */
  player: string;
  /** Underlying device entity (e.g. a Cast player); used to ignore stale "paused" states. */
  device?: string;
  /** Music Assistant "favourite current song" button for this player. */
  favorite_button?: string;
}

export interface LightRoomConfig {
  name: string;
  /** Group (or single) light for the room. */
  entity: string;
  icon?: string;
  /** Individual lights shown on the Lights page. */
  members?: string[];
  scenes?: NamedEntity[];
}

export interface PanelConfig {
  /** Hide Home Assistant's sidebar on this panel (also enabled with ?kiosk=1). */
  kiosk?: boolean;
  /** input_text / input_select whose value is the page to show: home, music, calendar, … or "photos". */
  page_entity?: string;
  /** Seconds of no touches before the photo screensaver starts (0 = never). */
  idle_seconds?: number;
  /** Page to return to after the screensaver (default "home"). */
  home_page?: string;

  weather?: string;
  calendars?: string[];
  todo_lists?: NamedEntity[];

  music?: {
    rooms: RoomConfig[];
    /** input_select shared with voice automations for the chosen music room. */
    room_entity?: string;
    /** Radio stations shown as a row of tiles: a Music Assistant URI (e.g. a BBC Sounds station) and a logo. */
    radio?: { name: string; uri: string; image?: string }[];
  };

  lights?: LightRoomConfig[];
  /** Quick scenes on the Home page. */
  scenes?: NamedEntity[];

  timers?: {
    /** View Assist device sensor holding the `timers` attribute. */
    sensor: string;
    /** Switch that is on while a timer alarm is ringing. */
    alarm_switch?: string;
    /** Script with fields timer_id, minutes that extends a timer. */
    add_minute_script?: string;
    /** Quick-start buttons, in minutes. */
    quick?: number[];
  };

  energy?: {
    power?: string;
    rate?: string;
    costs?: NamedEntity[];
    /** Individual appliances on smart plugs: live power (W) and an energy sensor (kWh, total_increasing). */
    devices?: { name: string; icon?: string; power?: string; energy?: string }[];
  };

  bins?: {
    collections: { name: string; entity: string; color?: string }[];
    /** input_boolean that is on the evening before a collection. */
    due_entity?: string;
    /** input_boolean the user turns on once the bin is out. */
    out_entity?: string;
  };

  voice?: {
    satellite: string;
    stt?: string;
    tts?: string;
  };

  photos?: { url: string };
  media?: { url: string; title?: string };
  transit?: TransitConfig;
}

/** One departure row as published by the board sensor's `departures` attribute. */
export interface TransitDeparture {
  line?: string;
  to: string;
  /** "14:51", "5 min" or "Due" */
  time: string;
  live?: boolean;
}

/** A tram or bus line drawn as a strip map between two termini A and B. */
export interface TransitConfig {
  title?: string;
  icon?: string;
  /** CSS colour of the line */
  color?: string;
  /** Terminus A: name and the sensor whose `departures` attribute lists departures from it. */
  a: { name: string; sensor: string };
  b: { name: string; sensor: string };
  /** Stops from A to B with timetable run times: `ab` = minutes after leaving A, `ba` = minutes after leaving B. */
  stops: { name: string; short?: string; ab: number; ba: number; major?: boolean }[];
  /** Stop to highlight (defaults to A). */
  home?: string;
  /** Fallback minutes between departures when the board lists only one. */
  headway_min?: number;
  /** Walking time from the house to terminus A, in minutes; drives the "leave now?" advice. */
  walk_min?: number;
  /** The stop before A on the way in, with its board sensor and the run time to A. Gives real
   *  (timetabled or live) arrival times at A and the window the vehicle waits there. */
  approach?: { name: string; sensor: string; run_min: number };
  /** How long a vehicle typically waits at terminus A before leaving. When set, arrivals at A are
   *  shown as each departure minus this, instead of being estimated from the run from B. */
  layover_min?: number;
}

export interface PanelInfo {
  config: PanelConfig;
}

export type PageId = "home" | "music" | "calendar" | "weather" | "lights" | "timers" | "energy" | "media" | "transit";
