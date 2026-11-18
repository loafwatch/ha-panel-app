import { reg } from "../registry";
import { css, html, nothing } from "lit";
import { state } from "lit/decorators.js";
import { PageBase } from "./base";
import { call } from "../util";

/** A recipe card, normalised from the Mealie integration's responses. */
interface Card {
  id: string;
  slug: string;
  name: string;
  image?: string;
  time?: string;
  serves?: string;
  tags: string[];
  description?: string;
}

interface Detail extends Card {
  ingredients: { text: string; section?: string }[];
  steps: { text: string; title?: string }[];
}

/**
 * Recipes from Mealie (the Mealie integration). Scrollable cards with search,
 * tag filters and shuffle; a recipe opens into ingredients you can tick off and
 * steps with one-tap kitchen timers.
 */
export class PageRecipes extends PageBase {
  protected usesHub = true;
  @state() private cards: Card[] = [];
  @state() private loadState: "idle" | "loading" | "ok" | "error" = "idle";
  @state() private q = "";
  @state() private tag = "";
  @state() private open?: Detail;
  @state() private opening = "";
  @state() private ticked = new Set<number>();
  @state() private step = 0;
  private loadedAt = 0;
  private entry?: string;

  protected watched() {
    return [];
  }

  protected updated(changed: Map<string, unknown>) {
    super.updated?.(changed as any);
    if (this.active && (this.loadState === "idle" || Date.now() - this.loadedAt > 10 * 60 * 1000)) this.load();
  }

  private async configEntry() {
    if (this.entry) return this.entry;
    this.entry = this.config.recipes?.config_entry;
    if (!this.entry) {
      // works for any user: find a Mealie entity, then its device's config entry
      const ents: Record<string, any> = (this.hass as any).entities ?? {};
      const devs: Record<string, any> = (this.hass as any).devices ?? {};
      const e = Object.values(ents).find((x: any) => x.platform === "mealie" && x.device_id);
      this.entry = e ? devs[e.device_id]?.config_entries?.[0] : undefined;
    }
    if (!this.entry) {
      const es: any[] = await this.hass.callWS({ type: "config_entries/get", domain: "mealie" }).catch(() => []);
      this.entry = es.find((e) => e.state === "loaded")?.entry_id;
    }
    return this.entry;
  }

  private img(id?: string, image?: string) {
    const base = this.config.recipes?.url?.replace(/\/$/, "");
    if (!base || !id || !image) return undefined;
    return `${base}/api/media/recipes/${id}/images/min-original.webp`;
  }

  private card(r: any): Card {
    const fromSecs = (sec: any) => {
      const s = Number(sec);
      if (!s || s <= 0) return "";
      const m = Math.round(s / 60);
      return m >= 60 ? `${Math.floor(m / 60)} hr${m % 60 ? ` ${m % 60} min` : ""}` : `${m} min`;
    };
    const str = (v: any) => (typeof v === "string" && v.trim() ? v.trim() : "");
    const time =
      fromSecs(r.total_time_seconds) || str(r.total_time) || fromSecs((Number(r.prep_time_seconds) || 0) + (Number(r.perform_time_seconds) || 0)) || str(r.perform_time) || "";
    const yieldTxt = str(r.recipe_yield);
    const servings = Number(r.recipe_servings) || 0;
    const serves = yieldTxt || (servings ? `Serves ${servings}` : "");
    return {
      id: r.recipe_id ?? r.id,
      slug: r.slug,
      name: r.name,
      image: this.img(r.recipe_id ?? r.id, r.image),
      time: time || undefined,
      serves: serves && serves !== "0" ? serves : undefined,
      tags: (r.tags ?? []).map((t: any) => t.name).filter(Boolean),
      description: r.description || undefined,
    };
  }

  private async load() {
    this.loadState = this.cards.length ? "ok" : "loading";
    this.loadedAt = Date.now();
    const ce = await this.configEntry();
    if (!ce) {
      this.loadState = "error";
      return;
    }
    try {
      const r = await this.hub.respond<any>("mealie", "get_recipes", { config_entry_id: ce, result_limit: 500 });
      const items: any[] = r?.recipes?.items ?? r?.items ?? [];
      this.cards = items.map((x) => this.card(x)).sort((a, b) => a.name.localeCompare(b.name));
      this.loadState = "ok";
    } catch {
      this.loadState = "error";
    }
  }

  private async openRecipe(c: Card) {
    const ce = await this.configEntry();
    if (!ce) return;
    this.opening = c.slug;
    try {
      const r = await this.hub.respond<any>("mealie", "get_recipe", { config_entry_id: ce, recipe_id: c.slug });
      const x = r?.recipe ?? r ?? {};
      const ings: any[] = x.ingredients ?? x.recipe_ingredient ?? x.recipeIngredient ?? [];
      const steps: any[] = x.instructions ?? x.recipe_instructions ?? x.recipeInstructions ?? [];
      const ingText = (i: any) => {
        if (typeof i === "string") return i;
        if (i.display) return i.display;
        if (i.original_text || i.originalText) return i.original_text ?? i.originalText;
        const unit = i.unit?.name ?? "";
        const food = i.food?.name ?? "";
        return [i.quantity || "", unit, food, i.note ?? ""].filter((p) => String(p).trim()).join(" ");
      };
      this.open = {
        ...this.card({ ...x, recipe_id: x.recipe_id ?? x.id ?? c.id, slug: c.slug, name: x.name ?? c.name }),
        image: c.image,
        ingredients: ings.map((i) => ({ text: ingText(i), section: i.title || undefined })).filter((i) => i.text),
        steps: steps.map((s) => ({ text: typeof s === "string" ? s : s.text ?? "", title: s.title || undefined })).filter((s) => s.text),
      };
      this.ticked = new Set();
      this.step = 0;
    } finally {
      this.opening = "";
    }
  }

  private shuffle() {
    const pool = this.filtered();
    if (pool.length) this.openRecipe(pool[Math.floor(Math.random() * pool.length)]);
  }

  private filtered() {
    const q = this.q.trim().toLowerCase();
    return this.cards.filter((c) => (!this.tag || c.tags.includes(this.tag)) && (!q || c.name.toLowerCase().includes(q) || c.tags.some((t) => t.toLowerCase().includes(q))));
  }

  /** Minutes mentioned in a step ("roast for 40 minutes", "1 hour"), for a one-tap timer. */
  private stepMinutes(t: string) {
    const h = t.match(/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?)\b/i);
    const m = t.match(/(\d+)\s*(?:-\s*\d+\s*)?(?:minutes?|mins?)\b/i);
    const total = (h ? parseFloat(h[1]) * 60 : 0) + (m ? parseInt(m[1], 10) : 0);
    return total > 0 && total <= 600 ? Math.round(total) : 0;
  }

  private startTimer(mins: number, label: string) {
    const t = this.config.timers;
    if (!t) return;
    call(this.hass, "view_assist", "set_timer", { entity_id: t.sensor, type: "Timer", name: label, time: `${mins} minute${mins === 1 ? "" : "s"}` });
    this.toast(`Timer set for ${mins} minute${mins === 1 ? "" : "s"}`);
  }

  private toggleIng(i: number) {
    const s = new Set(this.ticked);
    s.has(i) ? s.delete(i) : s.add(i);
    this.ticked = s;
  }

  render() {
    if (this.open) return this.detail(this.open);
    const tags = [...new Set(this.cards.flatMap((c) => c.tags))].sort();
    const list = this.filtered();
    return html`
      <div class="page">
        <div class="bar">
          <div class="search">
            <ha-icon icon="mdi:magnify"></ha-icon>
            <input
              type="search"
              placeholder="Search recipes"
              .value=${this.q}
              @input=${(e: InputEvent) => (this.q = (e.target as HTMLInputElement).value)}
              enterkeyhint="search"
              autocomplete="off"
            />
            ${this.q ? html`<button class="clr" aria-label="Clear" @click=${() => (this.q = "")}><ha-icon icon="mdi:close"></ha-icon></button>` : nothing}
          </div>
          <button class="shuffle" aria-label="Pick something for me" @click=${this.shuffle}><ha-icon icon="mdi:dice-5-outline"></ha-icon></button>
        </div>
        ${tags.length
          ? html`<div class="chips">
              <button class=${this.tag ? "" : "on"} @click=${() => (this.tag = "")}>All</button>
              ${tags.map((t) => html`<button class=${this.tag === t ? "on" : ""} @click=${() => (this.tag = this.tag === t ? "" : t)}>${t}</button>`)}
            </div>`
          : nothing}
        ${this.loadState === "error"
          ? html`<div class="empty">Couldn't reach Mealie. Is it running, and is the Mealie integration set up?</div>`
          : this.loadState !== "ok"
            ? html`<div class="empty">Loading recipes…</div>`
            : !this.cards.length
              ? html`<div class="empty big"><ha-icon icon="mdi:chef-hat"></ha-icon>No recipes yet. Add some in Mealie: tap + then "Import from URL" and paste a recipe link.</div>`
              : !list.length
                ? html`<div class="empty">Nothing matches "${this.q || this.tag}"</div>`
                : html`<div class="grid">
                    ${list.map(
                      (c) => html`<button class="card tile ${this.opening === c.slug ? "busy" : ""}" @click=${() => this.openRecipe(c)}>
                        <div class="ph">
                          <ha-icon icon="mdi:silverware-fork-knife"></ha-icon>
                          ${c.image ? html`<img src=${c.image} alt="" loading="lazy" @error=${(e: Event) => ((e.target as HTMLElement).style.display = "none")} />` : nothing}
                        </div>
                        <div class="cn">${c.name}</div>
                        <div class="cm">
                          ${c.time ? html`<span><ha-icon icon="mdi:clock-outline"></ha-icon>${c.time}</span>` : nothing}
                          ${c.serves ? html`<span><ha-icon icon="mdi:account-group-outline"></ha-icon>${c.serves}</span>` : nothing}
                        </div>
                      </button>`,
                    )}
                  </div>`}
      </div>
    `;
  }

  private detail(r: Detail) {
    const cur = r.steps[this.step];
    const mins = cur ? this.stepMinutes(cur.text) : 0;
    return html`
      <div class="page fill">
        <div class="hero tile">
          <div class="hph">
            <ha-icon icon="mdi:silverware-fork-knife"></ha-icon>
            ${r.image ? html`<img src=${r.image} alt="" @error=${(e: Event) => ((e.target as HTMLElement).style.display = "none")} />` : nothing}
          </div>
          <div class="ht">
            <div class="hn">${r.name}</div>
            <div class="cm">
              ${r.time ? html`<span><ha-icon icon="mdi:clock-outline"></ha-icon>${r.time}</span>` : nothing}
              ${r.serves ? html`<span><ha-icon icon="mdi:account-group-outline"></ha-icon>${r.serves}</span>` : nothing}
            </div>
          </div>
          <button class="close" aria-label="Back to recipes" @click=${() => (this.open = undefined)}><ha-icon icon="mdi:close"></ha-icon></button>
        </div>
        <div class="cols">
          <div class="tile ings">
            <div class="sec">Ingredients <span>${this.ticked.size}/${r.ingredients.length}</span></div>
            <div class="scroll">
              ${r.ingredients.map(
                (g, i) => html`${g.section ? html`<div class="sub">${g.section}</div>` : nothing}
                  <button class="ing ${this.ticked.has(i) ? "done" : ""}" @click=${() => this.toggleIng(i)}>
                    <ha-icon icon=${this.ticked.has(i) ? "mdi:checkbox-marked-circle" : "mdi:checkbox-blank-circle-outline"}></ha-icon><span>${g.text}</span>
                  </button>`,
              )}
            </div>
          </div>
          <div class="tile method">
            <div class="sec">Method <span>${r.steps.length ? `Step ${this.step + 1} of ${r.steps.length}` : ""}</span></div>
            ${cur
              ? html`<div class="now">
                    ${cur.title ? html`<div class="sub">${cur.title}</div>` : nothing}
                    <div class="stxt">${cur.text}</div>
                  </div>
                  <div class="nav">
                    <button class="btn" ?disabled=${this.step === 0} @click=${() => (this.step = Math.max(0, this.step - 1))}><ha-icon icon="mdi:chevron-left"></ha-icon>Back</button>
                    ${mins && this.config.timers
                      ? html`<button class="btn primary" @click=${() => this.startTimer(mins, r.name.split(/\s+/).slice(0, 3).join(" "))}>
                          <ha-icon icon="mdi:timer-outline"></ha-icon>${mins} min timer
                        </button>`
                      : nothing}
                    <button class="btn" ?disabled=${this.step >= r.steps.length - 1} @click=${() => (this.step = Math.min(r.steps.length - 1, this.step + 1))}>
                      Next<ha-icon icon="mdi:chevron-right"></ha-icon>
                    </button>
                  </div>
                  <div class="dots">${r.steps.map((_, i) => html`<button class=${i === this.step ? "on" : i < this.step ? "past" : ""} aria-label="Step ${i + 1}" @click=${() => (this.step = i)}></button>`)}</div>`
              : html`<div class="empty">This recipe has no steps.</div>`}
          </div>
        </div>
      </div>
    `;
  }

  static styles = [
    PageBase.styles,
    css`
      button {
        font: inherit;
        color: inherit;
        border: 0;
        background: none;
        cursor: pointer;
        -webkit-tap-highlight-color: transparent;
      }
      .bar {
        display: flex;
        gap: 12px;
        margin-bottom: 12px;
      }
      .search {
        flex: 1;
        display: flex;
        align-items: center;
        gap: 10px;
        height: 52px;
        padding: 0 8px 0 16px;
        border-radius: 999px;
        background: var(--tile);
        box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--accent) 35%, transparent);
      }
      .search:focus-within {
        box-shadow: inset 0 0 0 2px var(--accent);
      }
      .search input {
        flex: 1;
        min-width: 0;
        border: 0;
        outline: 0;
        background: transparent;
        color: var(--text);
        font: 500 17px var(--font);
      }
      .search input::-webkit-search-cancel-button {
        display: none;
      }
      .search ha-icon {
        color: var(--text-2);
      }
      .clr {
        display: grid;
        place-items: center;
        width: 40px;
        height: 40px;
        border-radius: 50%;
      }
      .shuffle {
        display: grid;
        place-items: center;
        width: 52px;
        height: 52px;
        border-radius: 50%;
        background: var(--grad);
        color: #fff;
        --mdc-icon-size: 28px;
      }
      .chips {
        display: flex;
        gap: 8px;
        overflow-x: auto;
        scrollbar-width: none;
        margin-bottom: 16px;
        padding-bottom: 2px;
      }
      .chips button {
        flex: none;
        padding: 8px 16px;
        border-radius: 999px;
        background: var(--tile);
        font-weight: 600;
        font-size: 14px;
        box-shadow: inset 0 0 0 1px rgba(127, 127, 127, 0.2);
      }
      .chips button.on {
        background: var(--grad);
        color: #fff;
        box-shadow: none;
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
        gap: var(--gap);
      }
      .card {
        text-align: left;
        padding: 0;
        overflow: hidden;
        display: flex;
        flex-direction: column;
        transition: transform 0.1s;
      }
      .card:active {
        transform: scale(0.97);
      }
      .card.busy {
        opacity: 0.6;
      }
      .ph,
      .hph {
        position: relative;
        aspect-ratio: 16 / 10;
        display: grid;
        place-items: center;
        background: linear-gradient(135deg, color-mix(in srgb, var(--accent) 35%, var(--tile-2)), color-mix(in srgb, var(--cy) 30%, var(--tile-2)));
        color: rgba(255, 255, 255, 0.7);
        --mdc-icon-size: 40px;
      }
      .ph img,
      .hph img {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        object-fit: cover;
      }
      .cn {
        padding: 12px 14px 4px;
        font-size: 17px;
        font-weight: 600;
        line-height: 1.25;
      }
      .cm {
        display: flex;
        gap: 14px;
        padding: 0 14px 14px;
        font-size: 13px;
        color: var(--text-2);
      }
      .cm span {
        display: inline-flex;
        align-items: center;
        gap: 4px;
      }
      .cm ha-icon {
        --mdc-icon-size: 16px;
      }
      .empty.big {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 12px;
        padding: 60px 20px;
        text-align: center;
        --mdc-icon-size: 56px;
      }

      /* recipe view */
      .page.fill {
        display: flex;
        flex-direction: column;
        gap: var(--gap);
        height: 100%;
        box-sizing: border-box;
        overflow: hidden;
      }
      .hero {
        flex: none;
        display: flex;
        align-items: center;
        gap: 18px;
        padding: 10px;
      }
      .hph {
        width: 150px;
        aspect-ratio: 4 / 3;
        border-radius: 14px;
        overflow: hidden;
        flex: none;
      }
      .ht {
        flex: 1;
        min-width: 0;
      }
      .hn {
        font-size: 28px;
        font-weight: 600;
        line-height: 1.15;
        margin-bottom: 8px;
      }
      .ht .cm {
        padding: 0;
        font-size: 15px;
      }
      .close {
        display: grid;
        place-items: center;
        width: 56px;
        height: 56px;
        border-radius: 50%;
        background: var(--tile-2);
        flex: none;
        --mdc-icon-size: 28px;
      }
      .cols {
        flex: 1;
        min-height: 0;
        display: grid;
        grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.3fr);
        gap: var(--gap);
      }
      .ings,
      .method {
        display: flex;
        flex-direction: column;
        min-height: 0;
      }
      .sec span {
        float: right;
        color: var(--text-2);
        font-weight: 500;
        letter-spacing: 0;
        text-transform: none;
      }
      .scroll {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        scrollbar-width: none;
      }
      .sub {
        font-size: 13px;
        font-weight: 700;
        color: var(--cy);
        margin: 10px 0 4px;
      }
      .ing {
        display: flex;
        align-items: flex-start;
        gap: 10px;
        width: 100%;
        text-align: left;
        padding: 9px 2px;
        font-size: 18px;
        line-height: 1.35;
        border-bottom: 1px solid rgba(127, 127, 127, 0.12);
      }
      .ing ha-icon {
        flex: none;
        color: var(--accent);
        margin-top: 1px;
      }
      .ing.done span {
        color: var(--text-2);
        text-decoration: line-through;
      }
      .ing.done ha-icon {
        color: #3ddc84;
      }
      .now {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        padding: 6px 2px;
      }
      .stxt {
        font-size: 24px;
        line-height: 1.5;
      }
      .nav {
        display: flex;
        gap: 10px;
        justify-content: space-between;
        margin-top: 12px;
      }
      .nav .btn {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 14px 20px;
        font-size: 16px;
      }
      .nav .btn[disabled] {
        opacity: 0.35;
      }
      .dots {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        justify-content: center;
        margin-top: 12px;
      }
      .dots button {
        width: 12px;
        height: 12px;
        border-radius: 50%;
        background: rgba(127, 127, 127, 0.3);
      }
      .dots button.past {
        background: color-mix(in srgb, var(--accent) 45%, transparent);
      }
      .dots button.on {
        background: var(--accent);
        width: 28px;
        border-radius: 6px;
      }
      @container (max-width: 760px) {
        .cols {
          grid-template-columns: 1fr;
          overflow-y: auto;
        }
        .page.fill {
          overflow-y: auto;
          height: auto;
        }
        .hph {
          width: 96px;
        }
        .hn {
          font-size: 22px;
        }
      }
    `,
  ];
}

reg("panel-recipes", PageRecipes);
