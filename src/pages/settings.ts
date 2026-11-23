import { reg } from "../registry";
import { css, html, nothing } from "lit";
import { state } from "lit/decorators.js";
import { PageBase } from "./base";

/** Sentences read during voice enrolment: ~6 s each, varied sounds, everyday words. */
export const ENROL_SENTENCES = [
  "The weather looks bright this morning, so we might walk to the park after breakfast.",
  "Could you remind me where I left the car keys and the shopping list yesterday?",
  "My favourite sandwich has cheese, tomato and a little bit of pickle on brown bread.",
  "We should water the garden, feed the fish and check the post before it gets dark.",
  "On Saturday afternoon the whole family is going swimming, then out for pizza.",
];

interface Voice {
  name: string;
  recordings?: number;
  built?: string;
}

type Flow =
  | { step: "pick" }
  | { step: "intro"; name: string; label: string; mode: "replace" | "add" }
  | { step: "reading"; name: string; label: string; mode: "replace" | "add" }
  | { step: "done"; label: string }
  | { step: "remove"; voice: Voice };

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Settings page. Currently: Voices - enrol a person's voice for voice match
 * (who's speaking), improve it, or remove it. Enrolment is driven by the
 * voice-match server via a Home Assistant service; progress comes back on a
 * status sensor.
 */
export class PageSettings extends PageBase {
  @state() private flow?: Flow;
  @state() private other = "";
  @state() private busy = false;

  private get vm() {
    return this.config.voice_match;
  }
  private get status() {
    return this.vm ? this.st(this.vm.status_sensor) : undefined;
  }

  protected watched() {
    return [this.vm?.status_sensor ?? ""];
  }

  private get voices(): Voice[] {
    const v = this.status?.attributes.voices;
    return Array.isArray(v) ? v : [];
  }

  private people(): { name: string; label: string }[] {
    return (this.vm?.people ?? []).map((id) => {
      const label = String(this.hass.states[id]?.attributes.friendly_name ?? id.replace(/^person\./, "")).split(" ")[0];
      return { name: label.toLowerCase().replace(/[^a-z0-9_-]/g, ""), label };
    });
  }

  private label(name: string) {
    return this.people().find((p) => p.name === name)?.label ?? cap(name.replace(/[_-]/g, " "));
  }

  private async control(path: string, body: Record<string, unknown> = {}) {
    if (!this.vm) return;
    const [domain, service] = this.vm.control_service.split(".");
    this.busy = true;
    try {
      await this.hass.callService(domain, service, { path, body });
    } catch (e: any) {
      this.toast(`Voice match didn't respond: ${e?.message ?? e}`);
      throw e;
    } finally {
      this.busy = false;
    }
  }

  private setAwake(on: boolean) {
    this.dispatchEvent(new CustomEvent("panel-keep-awake", { detail: { on }, bubbles: true, composed: true }));
  }

  private async begin() {
    const f = this.flow;
    if (f?.step !== "intro") return;
    try {
      await this.control("enrol/start", { name: f.name, total: ENROL_SENTENCES.length, mode: f.mode });
      this.flow = { ...f, step: "reading" };
      this.setAwake(true);
    } catch {
      /* toast shown */
    }
  }

  private async cancel() {
    if (this.flow?.step === "reading") {
      try {
        await this.control("enrol/cancel");
      } catch {
        /* still close */
      }
    }
    this.setAwake(false);
    this.flow = undefined;
  }

  private async removeVoice(v: Voice) {
    try {
      await this.control("voices/delete", { name: v.name });
      this.toast(`${this.label(v.name)}'s voice removed`);
    } catch {
      /* toast shown */
    }
    this.flow = undefined;
  }

  protected updated(changed: Map<string, unknown>) {
    super.updated(changed);
    const f = this.flow;
    const s = this.status;
    if (f?.step === "reading" && s) {
      const msg = String(s.attributes.message ?? "");
      if (s.state === "idle" && msg.startsWith("complete")) {
        this.setAwake(false);
        this.flow = { step: "done", label: f.label };
      } else if (s.state === "idle" && (msg === "timed out" || msg === "cancelled")) {
        this.setAwake(false);
        this.flow = undefined;
        this.toast(msg === "timed out" ? "Voice enrolment timed out" : "Voice enrolment cancelled");
      }
    }
  }

  // ---------- render ----------

  render() {
    if (!this.vm) return nothing;
    return html`<div class="page">
      <div class="page-title">Settings</div>
      <div class="tile">
        <div class="label"><ha-icon icon="mdi:account-voice"></ha-icon>Voices</div>
        <div class="muted intro">
          Jarvis can recognise who's speaking, so "remind me" goes to the right person and the TV doesn't get in the way.
          Voices are stored on the home server as numbers only, never as recordings.
        </div>
        ${this.voices.length
          ? html`<div class="voices">
              ${this.voices.map(
                (v) => html`<div class="voice">
                  <ha-icon icon="mdi:account-circle"></ha-icon>
                  <div class="vname">${this.label(v.name)}<div class="muted small">${v.recordings ?? "?"} samples${v.built ? html` · ${v.built.slice(0, 10)}` : nothing}</div></div>
                  <span class="grow"></span>
                  <button class="btn" @click=${() => (this.flow = { step: "intro", name: v.name, label: this.label(v.name), mode: "add" })}>
                    <ha-icon icon="mdi:plus"></ha-icon>Improve
                  </button>
                  <button class="btn" @click=${() => (this.flow = { step: "intro", name: v.name, label: this.label(v.name), mode: "replace" })}>
                    <ha-icon icon="mdi:refresh"></ha-icon>Re-record
                  </button>
                  <button class="btn icon" aria-label="Remove" @click=${() => (this.flow = { step: "remove", voice: v })}>
                    <ha-icon icon="mdi:delete-outline"></ha-icon>
                  </button>
                </div>`
              )}
            </div>`
          : html`<div class="empty">No voices enrolled yet.</div>`}
        <button class="btn primary add" @click=${() => ((this.other = ""), (this.flow = { step: "pick" }))}>
          <ha-icon icon="mdi:microphone-plus"></ha-icon>Enrol a voice
        </button>
      </div>
      ${this.sheet()}
    </div>`;
  }

  private sheet() {
    const f = this.flow;
    if (!f) return nothing;
    const close = () => (f.step === "reading" ? this.cancel() : (this.flow = undefined));
    return html`<div class="scrim" @click=${close}>
      <div class="tile sheet ${f.step === "reading" ? "big" : ""}" @click=${(e: Event) => e.stopPropagation()}>${this.sheetBody(f)}</div>
    </div>`;
  }

  private sheetBody(f: Flow) {
    if (f.step === "pick") {
      const enrolled = new Set(this.voices.map((v) => v.name));
      const people = this.people();
      const otherName = this.other.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
      const start = (name: string, label: string) =>
        (this.flow = { step: "intro", name, label, mode: "replace" });
      return html`
        <div class="label"><ha-icon icon="mdi:microphone-plus"></ha-icon>Enrol a voice</div>
        <div class="ptitle">Whose voice?</div>
        <div class="chips">
          ${people.map((p) => html`<button class="chip" @click=${() => start(p.name, p.label)}>${p.label}${enrolled.has(p.name) ? " (re-record)" : ""}</button>`)}
        </div>
        <div class="sub">Someone else</div>
        <div class="row">
          <input class="field" placeholder="First name" .value=${this.other} @input=${(e: Event) => (this.other = (e.target as HTMLInputElement).value)} />
          <button class="btn primary" ?disabled=${!otherName} @click=${() => start(otherName, cap(this.other.trim()))}>Next</button>
        </div>
        <div class="row"><span class="grow"></span><button class="btn" @click=${() => (this.flow = undefined)}>Cancel</button></div>
      `;
    }
    if (f.step === "intro") {
      return html`
        <div class="label"><ha-icon icon="mdi:account-voice"></ha-icon>${f.mode === "add" ? "Improve" : "Enrol"} ${f.label}'s voice</div>
        <div class="ptitle">${ENROL_SENTENCES.length} sentences, about a minute</div>
        <ol class="howto">
          <li>Turn the TV off. Only ${f.label} should talk.</li>
          <li>Stand where you'd normally talk to Jarvis.</li>
          <li>For each sentence, say <b>"Hey Jarvis"</b>, wait for it to listen, then read the sentence normally.</li>
        </ol>
        ${f.mode === "add"
          ? html`<div class="muted hint">These samples are added to ${f.label}'s voice, which helps it cope with different days and background noise. Tip: try this one with the TV on quietly.</div>`
          : this.voices.some((v) => v.name === f.name)
            ? html`<div class="muted hint">This replaces ${f.label}'s current voice once all ${ENROL_SENTENCES.length} sentences are done.</div>`
            : nothing}
        <div class="row">
          <span class="grow"></span>
          <button class="btn" @click=${() => (this.flow = undefined)}>Cancel</button>
          <button class="btn primary" ?disabled=${this.busy} @click=${() => this.begin()}><ha-icon icon="mdi:microphone"></ha-icon>Start</button>
        </div>
      `;
    }
    if (f.step === "reading") {
      const s = this.status;
      const done = Math.min(Number(s?.attributes.done ?? 0), ENROL_SENTENCES.length);
      const msg = String(s?.attributes.message ?? "");
      const note =
        msg === "too short"
          ? "Didn't catch enough of that. Please read it again."
          : msg.startsWith("sounded like")
            ? `That sounded like ${this.label(msg.replace("sounded like ", ""))}. Only ${f.label} should read.`
            : "";
      return html`
        <div class="label"><ha-icon icon="mdi:account-voice"></ha-icon>${f.label} · sentence ${Math.min(done + 1, ENROL_SENTENCES.length)} of ${ENROL_SENTENCES.length}</div>
        <div class="dots">${ENROL_SENTENCES.map((_, i) => html`<i class=${i < done ? "on" : i === done ? "now" : ""}></i>`)}</div>
        <div class="say">Say <b>"Hey Jarvis"</b>, then read:</div>
        <div class="sentence">${ENROL_SENTENCES[Math.min(done, ENROL_SENTENCES.length - 1)]}</div>
        ${note ? html`<div class="note"><ha-icon icon="mdi:alert-circle-outline"></ha-icon>${note}</div>` : nothing}
        <div class="row"><span class="grow"></span><button class="btn" @click=${() => this.cancel()}>Cancel</button></div>
      `;
    }
    if (f.step === "done") {
      return html`
        <div class="label"><ha-icon icon="mdi:check-circle"></ha-icon>All done</div>
        <div class="ptitle">Jarvis will recognise ${f.label} from now on.</div>
        <div class="row"><span class="grow"></span><button class="btn primary" @click=${() => (this.flow = undefined)}>Done</button></div>
      `;
    }
    const v = f.voice;
    return html`
      <div class="label"><ha-icon icon="mdi:delete-outline"></ha-icon>Remove voice</div>
      <div class="ptitle">Remove ${this.label(v.name)}'s voice?</div>
      <div class="muted hint">Jarvis will stop recognising ${this.label(v.name)}. Their stored voice samples are deleted and can't be recovered, but you can enrol again at any time.</div>
      <div class="row">
        <span class="grow"></span>
        <button class="btn" @click=${() => (this.flow = undefined)}>Keep</button>
        <button class="btn primary" ?disabled=${this.busy} @click=${() => this.removeVoice(v)}>Remove</button>
      </div>
    `;
  }

  static styles = [
    PageBase.styles,
    css`
      .page {
        max-width: 900px;
        margin: 0 auto;
      }
      .intro {
        font-size: 15px;
        line-height: 1.45;
        margin-bottom: 14px;
      }
      .voices {
        display: flex;
        flex-direction: column;
        gap: 10px;
        margin-bottom: 16px;
      }
      .voice {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 12px 14px;
        border-radius: var(--radius-sm);
        background: var(--tile-2);
        --mdc-icon-size: 30px;
      }
      .voice > ha-icon {
        color: var(--accent);
      }
      .vname {
        font-size: 18px;
        font-weight: 700;
      }
      .small {
        font-size: 13px;
        font-weight: 400;
      }
      .grow {
        flex: 1;
      }
      .btn.icon {
        padding: 10px;
      }
      .add {
        margin-top: 4px;
      }
      .scrim {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.55);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 20;
      }
      .sheet {
        width: min(640px, 92vw);
        display: flex;
        flex-direction: column;
        gap: 14px;
      }
      .sheet.big {
        width: min(900px, 94vw);
        padding: 28px 32px;
      }
      .ptitle {
        font-size: 22px;
        font-weight: 700;
      }
      .row {
        display: flex;
        gap: 10px;
        align-items: center;
        flex-wrap: wrap;
      }
      .row .field {
        flex: 1;
      }
      .field {
        font: 18px var(--font);
        padding: 12px 14px;
        border-radius: 12px;
        border: 1px solid var(--line);
        background: var(--tile-2);
        color: var(--text);
      }
      .sub {
        font-size: 13px;
        font-weight: 700;
        color: var(--text-2);
        text-transform: uppercase;
        letter-spacing: 0.06em;
      }
      .chips {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
      }
      .chip {
        font-size: 17px;
        padding: 12px 20px;
      }
      .howto {
        margin: 0;
        padding-left: 22px;
        font-size: 17px;
        line-height: 1.6;
      }
      .hint {
        font-size: 14px;
      }
      .dots {
        display: flex;
        gap: 10px;
      }
      .dots i {
        width: 14px;
        height: 14px;
        border-radius: 50%;
        background: var(--line);
      }
      .dots i.on {
        background: var(--grad);
      }
      .dots i.now {
        box-shadow: 0 0 0 3px var(--accent);
        background: var(--tile);
      }
      .say {
        font-size: 18px;
        color: var(--text-2);
      }
      .sentence {
        font-size: clamp(26px, 3.6vw, 40px);
        font-weight: 700;
        line-height: 1.3;
        padding: 10px 0 6px;
      }
      .note {
        display: flex;
        align-items: center;
        gap: 8px;
        color: var(--pk);
        font-size: 17px;
        font-weight: 600;
      }
    `,
  ];
}

reg("panel-settings", PageSettings);
