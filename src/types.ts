// Minimal Home Assistant types used by the panel.

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
  callService(domain: string, service: string, data?: Record<string, any>, target?: Record<string, any>): Promise<any>;
  callWS<T = any>(msg: Record<string, any>): Promise<T>;
}

/** A room the panel can play music in. All values come from the user's own HA config. */
export interface RoomConfig {
  name: string;
  /** Music Assistant player for this room. */
  player: string;
  /** Optional underlying device player (e.g. a Cast entity) used to detect stale states. */
  device?: string;
}

/** Install-specific settings, supplied via `panel_custom` -> `config:` in configuration.yaml. */
export interface PanelConfig {
  rooms?: RoomConfig[];
  /** input_select (or input_text) holding the page the panel should show; lets automations switch pages. */
  page_entity?: string;
}

export interface PanelInfo {
  config: PanelConfig;
}
