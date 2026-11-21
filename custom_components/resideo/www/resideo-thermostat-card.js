/*
 * Resideo thermostat cards: Home Assistant's own thermostat card, plus what a T9 shows around it.
 *
 *   type: custom:resideo-thermostat-card          Mode and Fan as the card's own T9-style buttons
 *   type: custom:resideo-thermostat-card-native   Mode and Fan as HA's built-in card features
 *   entity: climate.<thermostat>
 *
 * Both add, from the Resideo integration's entities on the same device: the room-priority count
 * and humidity at the dial's top corners; the hold status ("Following Schedule", "Using Away
 * Settings" when geofenced, "Schedule Off", or a pill that opens Hold Options / Vacation Hold like
 * the T9); and an upcoming-vacation note. The native card shows the hold status as a card feature,
 * `custom:resideo-hold-feature`, which also works on HA's own thermostat and tile cards.
 *
 * HA has no public component library for custom cards ("build or bundle your own"), so the
 * controls are native elements styled with HA's theme tokens:
 * https://contributors.home-assistant.io/frontend/custom-ui/#which-tools-to-use
 */

const HEAT = "var(--state-climate-heat-color, #ff8100)";
const COOL = "var(--state-climate-cool-color, #2b9af9)";

const MODES = {
  heat_cool: { label: "Auto", icon: "mdi:sun-snowflake-variant",
    color: "var(--state-climate-heat_cool-color, var(--state-climate-heat-cool-color, #ffc107))",
    desc: "Switches between heating and cooling automatically" },
  heat: { label: "Heat", icon: "mdi:fire", color: HEAT },
  cool: { label: "Cool", icon: "mdi:snowflake", color: COOL },
  off: { label: "Off", icon: "mdi:power", color: "var(--rc-text-2)",
    desc: "Both the heating and cooling systems remain off" },
};
const MODE_ORDER = ["heat_cool", "heat", "cool", "off"];
// CurrentSchedulePeriod -> the word a geofenced T9 shows ("Using Away Settings"), per the First
// Alert app's mapping (0xfac840).
const PERIOD_WORD = {
  Home: "Home", Occupied2: "Home", P1: "Home", P3: "Home",
  Away: "Away", Unoccupied1: "Away", P2: "Away",
  Sleep: "Sleep", Unoccupied2: "Sleep", P4: "Sleep",
};
const FANS = {
  auto: { label: "Auto", icon: "mdi:fan-auto" },
  on: { label: "On", icon: "mdi:fan" },
  Circulate: { label: "Circulate", icon: "mdi:fan-clock" },
};

// HA's documented theme tokens, each with the older variable (and a value) to fall back on:
// https://contributors.home-assistant.io/marketplace/reference/theme-variables/
const TOKENS = `
  --rc-text: var(--ha-color-text-primary, var(--primary-text-color));
  --rc-text-2: var(--ha-color-text-secondary, var(--secondary-text-color));
  --rc-fill: var(--ha-color-fill-neutral-quiet-resting, var(--secondary-background-color));
  --rc-border: var(--ha-color-border-neutral-quiet, var(--divider-color));
  --rc-focus: var(--ha-color-focus, var(--primary-color));
  --rc-control-h: var(--feature-height, 42px);
  --rc-radius: var(--feature-border-radius, var(--ha-border-radius-lg, 12px));
  --rc-gap: var(--feature-button-spacing, var(--ha-card-feature-gap, 12px));
  --rc-space-1: var(--ha-space-1, 4px);
  --rc-space-2: var(--ha-space-2, 8px);
  --rc-space-4: var(--ha-space-4, 16px);
  --rc-weight: var(--ha-font-weight-action, var(--ha-font-weight-medium, 500));
  --rc-font-s: var(--ha-font-size-s, 12px);
  --rc-font-m: var(--ha-font-size-m, 14px);
  --rc-font-l: var(--ha-font-size-l, 16px);
`;

// Controls and the popups, shared by the cards and the feature.
const CONTROL_STYLE = `
  button { font: inherit; cursor: pointer; -webkit-tap-highlight-color: transparent; }
  /* HA's state layer: a wash of the control's own text colour over whatever background it has
     (8% hover, 12% pressed), and a focus ring for the keyboard. */
  @media (hover: hover) {
    button:not(:disabled):hover { background-image: linear-gradient(color-mix(in srgb, currentColor 8%, transparent), color-mix(in srgb, currentColor 8%, transparent)); }
  }
  button:not(:disabled):active { background-image: linear-gradient(color-mix(in srgb, currentColor 12%, transparent), color-mix(in srgb, currentColor 12%, transparent)); }
  button:focus-visible, .row input:focus-visible { outline: 2px solid var(--rc-focus); outline-offset: 2px; }
  .status { display: flex; justify-content: center; align-items: center; gap: var(--rc-space-2); min-height: var(--rc-control-h); }
  .status .plain { font-size: var(--rc-font-m); color: var(--rc-text); }
  .status .plain.off { display: flex; align-items: center; gap: var(--rc-space-2); color: var(--rc-text-2); }
  .status .plain.off ha-icon { --mdc-icon-size: 20px; }
  .pill { min-height: var(--rc-control-h); padding: 0 20px; border-radius: calc(var(--rc-control-h) / 2);
    border: 1.5px solid var(--rc-text); background: transparent; color: var(--rc-text);
    font-size: var(--rc-font-m); font-weight: var(--rc-weight); white-space: nowrap; }
  .caption { text-align: center; font-size: var(--rc-font-s); color: var(--rc-text-2); }
  /* A native modal <dialog>: shown in the page's top layer, so it sits over the whole dashboard and
     is never rebuilt by the card's own updates. */
  dialog.dlg { width: min(360px, calc(100vw - 32px)); max-height: calc(100vh - 32px); box-sizing: border-box;
    padding: var(--rc-space-4); border: none; border-radius: var(--ha-border-radius-xl, 24px); overflow: auto;
    background: var(--ha-card-background, var(--card-background-color, #1c1c1c)); color: var(--rc-text);
    font-family: var(--ha-font-family-body, Roboto, system-ui, sans-serif); box-shadow: 0 8px 24px rgba(0,0,0,0.4); }
  dialog.dlg[open] { display: flex; flex-direction: column; gap: var(--rc-space-2); }
  dialog.dlg::backdrop { background: rgba(0,0,0,0.55); backdrop-filter: var(--ha-dialog-scrim-backdrop-filter, none); }
  .dlg .head { display: flex; align-items: center; gap: var(--rc-space-1); font-size: var(--rc-font-l); font-weight: var(--rc-weight); }
  .dlg .head button { width: 40px; height: 40px; border-radius: 50%; border: none; background: transparent; color: inherit; font-size: 24px; }
  .dlg p { margin: 0 0 var(--rc-space-1); text-align: center; font-size: var(--rc-font-m); line-height: var(--ha-line-height-normal, 1.6); color: var(--rc-text-2); }
  .opt { min-height: var(--rc-control-h); border-radius: calc(var(--rc-control-h) / 2); border: 1.5px solid var(--rc-text);
    background: transparent; color: var(--rc-text); font-size: var(--rc-font-m); font-weight: var(--rc-weight); }
  .opt:disabled { opacity: 0.4; cursor: not-allowed; }
  hr { border: none; border-top: 1px solid var(--rc-border); margin: var(--rc-space-1) 0; width: 100%; }
  .row { display: flex; gap: var(--rc-space-2); align-items: flex-end; }
  .row label { flex: 1; display: flex; flex-direction: column; gap: var(--rc-space-1); font-size: var(--rc-font-s); color: var(--rc-text-2); }
  .row input { min-height: var(--rc-control-h); padding: 0 10px; border-radius: var(--rc-radius); border: 1px solid var(--rc-border);
    background: var(--rc-fill); color: var(--rc-text); font-size: var(--rc-font-m); color-scheme: inherit; }
  .go { min-height: var(--rc-control-h); padding: 0 18px; border-radius: calc(var(--rc-control-h) / 2); border: none;
    background: var(--ha-color-fill-primary-loud-resting, var(--primary-color));
    color: var(--ha-color-text-primary-inverted, var(--text-primary-color, #fff)); font-weight: var(--rc-weight); }
  .item { min-height: 48px; padding: 6px 12px; border-radius: var(--rc-radius); border: 1.5px solid transparent; background: transparent;
    color: var(--rc-text); display: flex; align-items: center; gap: var(--rc-gap); text-align: left; }
  .item.on { border-color: var(--rc-text); }
  .item ha-icon { --mdc-icon-size: 28px; flex-shrink: 0; }
  .item small { display: block; font-size: var(--rc-font-s); color: var(--rc-text-2); }
  .error { color: var(--ha-color-text-danger, var(--error-color, #db4437)); font-size: var(--rc-font-s); text-align: center; }
`;

const CARD_STYLE = `
  :host { display: block; ${TOKENS} }
  ha-card { position: relative; }
  .inner { --ha-card-background: transparent; --ha-card-border-width: 0; --ha-card-box-shadow: none; --ha-card-border-color: transparent; }
  .corner { position: absolute; top: 52px; display: flex; align-items: center; gap: 6px;
    font-size: 22px; color: var(--rc-text); pointer-events: none; }
  .corner.left { left: 18px; } .corner.right { right: 18px; }
  .corner ha-icon { --mdc-icon-size: 24px; color: var(--rc-text-2); }
  .extras > .status { margin: -6px var(--rc-space-4) 0; }
  .extras > .caption { margin-top: 2px; }
  .note { display: flex; align-items: center; gap: var(--rc-space-2); margin: 10px var(--rc-space-4) 0; padding: var(--rc-space-2) 12px;
    border-radius: var(--rc-radius); background: var(--rc-fill); font-size: var(--rc-font-s); color: var(--rc-text); }
  .note ha-icon { --mdc-icon-size: 18px; color: var(--rc-text-2); }
  .note:last-child { margin-bottom: var(--rc-space-4); }
  .chips { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--rc-space-2); margin: 12px var(--rc-space-4) var(--rc-space-4); }
  .chip { min-height: var(--rc-control-h); border-radius: var(--rc-radius); border: none; display: flex; align-items: center; justify-content: center;
    gap: var(--rc-space-2); font-size: var(--rc-font-m); font-weight: var(--rc-weight); background: var(--rc-fill); color: var(--rc-text); }
  .chip ha-icon { --mdc-icon-size: 20px; }
  .chip[aria-expanded="true"] { outline: 1.5px solid var(--rc-text); outline-offset: -1.5px; }
  /* Mode/Fan: a dropdown under its button, in the page's top layer (the popover API: closes on an
     outside click or Esc). Placed by script, since anchor positioning isn't in every browser yet. */
  .menu { position: fixed; inset: auto; margin: 0; box-sizing: border-box; min-width: 200px; max-width: min(320px, calc(100vw - 16px));
    padding: var(--rc-space-1); border: 1px solid var(--rc-border); border-radius: var(--rc-radius);
    background: var(--ha-card-background, var(--card-background-color, #1c1c1c)); color: var(--rc-text);
    font-family: var(--ha-font-family-body, Roboto, system-ui, sans-serif); box-shadow: 0 6px 18px rgba(0,0,0,0.3); }
  .menu:popover-open { display: flex; flex-direction: column; gap: 2px; }
  .menu .item { min-height: 44px; padding: 6px 10px; border-width: 0; }
  .menu .item.on { background: var(--rc-fill); }
  .menu .item ha-icon { --mdc-icon-size: 24px; }
  ${CONTROL_STYLE}
`;

const FEATURE_STYLE = `
  :host { display: block; ${TOKENS} }
  .status { height: var(--rc-control-h); }
  ${CONTROL_STYLE}
`;

function fmtTime(d) {
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
function fmtDay(d) {
  return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// What the cards and the feature share: reading the device's entities, the T9 status, and the
// popups. A subclass sets this._root and this._dlg, and defines _entityId and _render().
class ResideoBase extends HTMLElement {
  _setupDialog() {
    this._dlg = this._root.querySelector("dialog");
    this._root.addEventListener("click", (ev) => this._onClick(ev));
    this._root.addEventListener("input", (ev) => { if (ev.target.name === "until") this._until = ev.target.value; });
    // Esc closes the dialog natively; keep the element's idea of it in step.
    this._dlg.addEventListener("close", () => { this._dialog = null; this._error = ""; this._lastDialog = ""; });
  }

  // Entities of the same device, by the integration's translation key (entity_id as a fallback).
  _sibling(key, domain = "sensor") {
    const ents = this._hass.entities || {};
    const me = ents[this._entityId];
    if (!me) return undefined;
    const hit = Object.values(ents).find((e) => e.device_id === me.device_id && e.platform === "resideo" &&
      e.entity_id.startsWith(domain + ".") &&
      (e.translation_key === key || e.entity_id.endsWith("_" + key)));
    return hit ? this._hass.states[hit.entity_id] : undefined;
  }

  _time(key) {
    const s = this._sibling(key);
    if (!s || ["unknown", "unavailable", ""].includes(s.state)) return null;
    const d = new Date(s.state);
    return isNaN(d) ? null : d;
  }

  // The line under the dial, as a T9 shows it.
  _status(st) {
    const preset = st.attributes.preset_mode || "none";
    const holdUntil = this._time("hold_until");
    // Schedule mode, as the First Alert app reads it (status builder 0xfac660; T9 manual p. 16).
    const schedule = this._sibling("schedule", "switch");
    const scheduleOff = schedule && schedule.state === "off";
    const type = (this._sibling("schedule_type") || {}).state || "";
    this._geo = type.startsWith("Geofenced");
    const period = PERIOD_WORD[(this._sibling("schedule_period") || {}).state];

    if (preset === "vacation") return { pill: "Vacation Hold", dialog: "vacation" };
    // With the schedule off the T9 holds permanently: there is nothing to return to.
    if (scheduleOff) return { off: "Schedule Off" };
    if (preset === "hold_until") return { pill: holdUntil ? `Hold until ${fmtTime(holdUntil)}` : "Hold until next period", dialog: "hold" };
    if (preset === "permanent_hold") return { pill: "Permanent Hold", dialog: "hold" };
    if (preset === "temporary_hold") {
      // A geofenced hold lasts until someone crosses the geofence (T9 manual p. 16).
      const caption = !this._geo ? "" : period === "Away" ? "Until someone arrives home" : "Until everyone leaves";
      return { pill: "Temporary Hold", dialog: "hold", caption };
    }
    if (st.state === "off") return { plain: "" };
    // No preset stands for it; the raw status sensor does.
    if ((this._sibling("setpoint_status") || {}).state === "StandBySetpoint") return { plain: "Standby Setpoints Active" };
    if (this._geo && period) return { plain: `Using ${period} Settings` };
    return { plain: "Following Schedule" };
  }

  _statusHtml(status, captionInline = false) {
    const main = status.pill
      ? `<button class="pill" data-act="open" data-dialog="${status.dialog}">${esc(status.pill)}</button>`
      : status.off
        ? `<span class="plain off"><ha-icon icon="mdi:calendar-remove-outline"></ha-icon>${esc(status.off)}</span>`
        : `<span class="plain">${esc(status.plain)}</span>`;
    const caption = status.caption ? `<span class="caption">${esc(status.caption)}</span>` : "";
    return captionInline ? `<div class="status">${main}${caption}</div>`
      : `<div class="status">${main}</div>${caption ? `<div class="caption">${esc(status.caption)}</div>` : ""}`;
  }

  // The open dialog follows the thermostat (someone may change it from the app, the device or
  // another Home Assistant user meanwhile) without being rebuilt unless what it shows changed,
  // and closes itself when what it is about has gone.
  _renderDialog(st) {
    const dlg = this._dlg;
    const preset = st.attributes.preset_mode || "none";
    if (this._dialog === "vacation" && preset !== "vacation") this._dialog = null;
    const body = this._dialog ? this._dialogBody(st) : "";
    if (!body) {
      if (dlg.open) dlg.close();
      return;
    }
    if (body !== this._lastDialog) {
      dlg.innerHTML = body;
      this._lastDialog = body;
    }
    if (!dlg.open) dlg.showModal();
  }

  _dialogBody(st) {
    const d = this._dialog;
    if (!d) return "";
    const err = this._error ? `<div class="error">${esc(this._error)}</div>` : "";
    const head = (title) => `<div class="head"><button data-act="close" aria-label="Back">‹</button>${esc(title)}</div>`;
    let body = "";
    if (d === "hold" || d === "time") {
      // Geofenced: a hold ends at the next arrival or departure, and has no end time to pick.
      const picking = this._geo ? ""
        : d === "time"
          ? `<div class="row"><label>Hold until<input type="time" name="until" value="${esc(this._until || "")}"></label><button class="go" data-act="time">Hold</button></div>`
          : `<button class="opt" data-act="pick-time">A Specific Time…</button>`;
      const next = this._geo
        ? `<button class="opt" data-act="preset" data-value="temporary_hold">Next Event</button>`
        : `<button class="opt" data-act="preset" data-value="hold_until">Next Period</button>`;
      body = `${head("Hold Options")}<p>Use current temperature, fan and comfort priority settings until…</p>
        ${next}${picking}
        <button class="opt" data-act="preset" data-value="permanent_hold">Permanently</button><hr>
        <button class="opt" data-act="preset" data-value="none">Remove Hold</button>`;
    } else if (d === "vacation") {
      const vEnd = this._time("vacation_end");
      const until = vEnd ? `${fmtDay(vEnd)} at ${fmtTime(vEnd)}` : "its end";
      body = `${head("Vacation Hold")}<p>Vacation mode is in effect until ${esc(until)}</p>
        <button class="opt" data-act="end-vacation">End Vacation</button>`;
    }
    return `${body}${err}`;
  }

  // The Mode or Fan choices, for the dropdown.
  _menuBody(st, which) {
    const err = this._error ? `<div class="error">${esc(this._error)}</div>` : "";
    if (which === "mode") {
      const modes = MODE_ORDER.filter((m) => (st.attributes.hvac_modes || []).includes(m));
      return modes.map((m) => `<button class="item ${m === st.state ? "on" : ""}" role="menuitemradio" aria-checked="${m === st.state}" data-act="mode" data-value="${m}">
        <ha-icon icon="${MODES[m].icon}" style="color:${MODES[m].color}"></ha-icon><span>${MODES[m].label}${MODES[m].desc ? `<small>${MODES[m].desc}</small>` : ""}</span></button>`).join("") + err;
    }
    return (st.attributes.fan_modes || []).map((f) => {
      const info = FANS[f] || { label: f, icon: "mdi:fan" };
      const on = f === st.attributes.fan_mode;
      return `<button class="item ${on ? "on" : ""}" role="menuitemradio" aria-checked="${on}" data-act="fan" data-value="${esc(f)}"><ha-icon icon="${info.icon}"></ha-icon><span>${esc(info.label)}</span></button>`;
    }).join("") + err;
  }

  async _call(domain, service, data) {
    try {
      await this._hass.callService(domain, service, { entity_id: this._entityId, ...data });
      this._dialog = null;
      this._error = "";
      this._closeMenu();
    } catch (e) {
      this._error = e && e.message ? e.message : String(e);
    }
    this._render();
  }

  _onClick(ev) {
    // The backdrop belongs to the dialog element: a click on the element outside its box is
    // a click on the backdrop (one inside its padding is not).
    if (ev.composedPath()[0] === this._dlg) {
      const r = this._dlg.getBoundingClientRect();
      if (ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom) this._dlg.close();
      return;
    }
    const el = ev.composedPath().find((n) => n.dataset && n.dataset.act);
    if (!el) return;
    const act = el.dataset.act;
    if (act === "menu") { this._toggleMenu(el); return; }
    if (act === "open") { this._dialog = el.dataset.dialog; this._error = ""; }
    else if (act === "close") { this._dlg.close(); return; }
    else if (act === "pick-time") { this._dialog = "time"; }
    else if (act === "time") {
      if (!this._until) { this._error = "Pick a time first."; this._render(); return; }
      return this._call("resideo", "set_hold_until", { until: this._until });
    }
    else if (act === "end-vacation") return this._call("resideo", "end_vacation", {});
    else if (act === "preset") return this._call("climate", "set_preset_mode", { preset_mode: el.dataset.value });
    else if (act === "mode") return this._call("climate", "set_hvac_mode", { hvac_mode: el.dataset.value });
    else if (act === "fan") return this._call("climate", "set_fan_mode", { fan_mode: el.dataset.value });
    this._render();
  }

  _closeMenu() {}
}

class ResideoThermostatCard extends ResideoBase {
  // The native card swaps the card's own Mode/Fan buttons and status for HA's card features.
  static NATIVE = false;

  setConfig(config) {
    if (!config || !config.entity || !config.entity.startsWith("climate.")) {
      throw new Error("Set 'entity' to a Resideo climate entity");
    }
    this._config = config;
    this._dialog = null;
    this._error = "";
    if (this._inner) this._inner.setConfig(this._innerConfig());
  }

  get _entityId() { return this._config.entity; }

  // HA's own thermostat card, as is: the room temperature as the big number (its "show current
  // as primary" option, on unless the card config turns it off).
  _innerConfig() {
    const config = { type: "thermostat", entity: this._config.entity,
      show_current_as_primary: this._config.show_current_as_primary ?? true };
    if (this.constructor.NATIVE) {
      const a = ((this._hass && this._hass.states[this._config.entity]) || {}).attributes || {};
      config.features = [
        { type: "climate-hvac-modes", style: "dropdown", hvac_modes: MODE_ORDER.filter((m) => (a.hvac_modes || []).includes(m)) },
        { type: "climate-fan-modes", style: "dropdown", fan_modes: a.fan_modes || [] },
        { type: "custom:resideo-hold-feature" },
      ];
    }
    return config;
  }

  // The inner card's ⋮ opens HA's generic entity dialog, which this card replaces: hide it.
  async _hideMoreInfo() {
    await this._inner.updateComplete;
    const root = this._inner.shadowRoot;
    if (!root || root.querySelector("style[data-resideo]")) return;
    const style = document.createElement("style");
    style.dataset.resideo = "";
    style.textContent = ".more-info { display: none !important; }";
    root.appendChild(style);
  }

  static getStubConfig(hass) {
    const climate = Object.values(hass.entities || {}).find((e) => e.platform === "resideo" && e.entity_id.startsWith("climate."));
    return { entity: climate ? climate.entity_id : "climate.thermostat" };
  }

  // The visual editor: HA builds it from this schema.
  static getConfigForm() {
    return {
      schema: [
        { name: "entity", required: true, selector: { entity: { domain: "climate", integration: "resideo" } } },
        { name: "show_current_as_primary", default: true, selector: { boolean: {} } },
      ],
      computeLabel: (s) => ({ entity: "Thermostat", show_current_as_primary: "Room temperature as the big number" }[s.name]),
      computeHelper: (s) => s.name === "show_current_as_primary" ? "Off: the target temperature is the big number" : undefined,
    };
  }

  getCardSize() { return 8; }
  getGridOptions() { return { columns: 12, min_columns: 6 }; }

  set hass(hass) {
    this._hass = hass;
    if (this._inner) this._inner.hass = hass;
    this._build();
    this._render();
  }

  async _build() {
    if (this._root) return;
    this._root = this.attachShadow({ mode: "open" });
    this._root.innerHTML = `<style>${CARD_STYLE}</style><ha-card><div class="inner"></div><div class="extras"></div></ha-card><dialog class="dlg"></dialog><div class="menu" popover="auto" role="menu"></div>`;
    this._setupDialog();
    this._menuEl = this._root.querySelector(".menu");
    // Closed by an outside click or Esc too: keep the card's idea of it in step.
    this._menuEl.addEventListener("toggle", (ev) => {
      // Skip a close that a reopen (switching Mode <-> Fan) has already overtaken.
      if (ev.newState !== "closed" || this._menuEl.matches(":popover-open")) return;
      cancelAnimationFrame(this._placing);
      // A click on the menu's own button closes it (outside click) before the click lands:
      // remember which, so that click doesn't reopen it.
      this._closedMenu = this._menu;
      this._closedAt = performance.now();
      this._menu = null; this._lastMenu = ""; this._error = ""; this._render();
    });
    const helpers = await window.loadCardHelpers();
    this._inner = await helpers.createCardElement(this._innerConfig());
    this._inner.hass = this._hass;
    this._root.querySelector(".inner").appendChild(this._inner);
    this._hideMoreInfo();
  }

  _render() {
    if (!this._root || !this._hass || !this._config) return;
    const st = this._hass.states[this._config.entity];
    const extras = this._root.querySelector(".extras");
    if (!st) { extras.innerHTML = `<div class="note">Entity not found: ${esc(this._config.entity)}</div>`; return; }
    const a = st.attributes;
    const rooms = this._sibling("priority_rooms");
    const vStart = this._time("vacation_start");
    const vEnd = this._time("vacation_end");
    const upcoming = a.preset_mode !== "vacation" && vStart && vStart > new Date() && vEnd
      ? `Upcoming vacation · ${fmtDay(vStart)}, ${fmtTime(vStart)} – ${fmtDay(vEnd)}, ${fmtTime(vEnd)}` : "";
    const humidity = a.current_humidity;

    let html = "";
    if (rooms && !isNaN(Number(rooms.state))) {
      html += `<div class="corner left" title="Rooms in the priority average"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true" style="color: var(--rc-text-2)"><path d="M3 11 12 4l9 7v9H3z"></path><rect x="8" y="11" width="4" height="4" fill="currentColor" stroke="none"></rect><rect x="12" y="15" width="4" height="4" fill="currentColor" stroke="none"></rect></svg><span>${esc(rooms.state)}</span></div>`;
    }
    if (humidity !== undefined && humidity !== null) {
      html += `<div class="corner right" title="Indoor humidity"><ha-icon icon="mdi:water-outline"></ha-icon><span>${esc(humidity)}%</span></div>`;
    }
    if (!this.constructor.NATIVE) html += this._statusHtml(this._status(st));
    if (upcoming) html += `<div class="note"><ha-icon icon="mdi:calendar-clock"></ha-icon><span>${esc(upcoming)}</span></div>`;
    if (!this.constructor.NATIVE) {
      const mode = MODES[st.state] || { label: st.state, icon: "mdi:thermostat" };
      const fan = FANS[a.fan_mode] || { label: a.fan_mode || "—", icon: "mdi:fan" };
      // The Mode button shows what the system is doing: orange while heating, blue while cooling.
      const running = a.hvac_action === "heating" ? HEAT : a.hvac_action === "cooling" ? COOL : null;
      const open = (m) => `aria-haspopup="menu" aria-expanded="${this._menu === m}"`;
      html += `<div class="chips">
        <button class="chip" data-act="menu" data-menu="mode" ${open("mode")} aria-label="Mode ${esc(mode.label)}, change"${running ? ` style="background: color-mix(in srgb, ${running} 20%, transparent)"` : ""}><ha-icon icon="${mode.icon}" style="color:${running || "var(--rc-text-2)"}"></ha-icon>${esc(mode.label)}</button>
        <button class="chip" data-act="menu" data-menu="fan" ${open("fan")} aria-label="Fan ${esc(fan.label)}, change"><ha-icon icon="${fan.icon}"></ha-icon>Fan · ${esc(fan.label)}</button>
      </div>`;
    }
    if (html !== this._lastHtml) {
      extras.innerHTML = html;
      this._lastHtml = html;
    }
    this._renderDialog(st);
    this._renderMenu(st);
  }

  // Like the dialog, an open dropdown follows the thermostat without being rebuilt needlessly.
  _renderMenu(st) {
    if (!this._menuEl || !this._menu) return;
    const body = this._menuBody(st, this._menu);
    if (body !== this._lastMenu) {
      this._menuEl.innerHTML = body;
      this._lastMenu = body;
    }
  }

  _toggleMenu(chip) {
    const which = chip.dataset.menu;
    if (this._menu === which) { this._closeMenu(); return; }
    if (this._closedMenu === which && performance.now() - this._closedAt < 400) { this._closedMenu = null; return; }
    this._closeMenu();
    this._menu = which;
    this._error = "";
    this._render();
    this._menuEl.showPopover();
    // Keep it under its button (same width, flipped above when there's no room below) while open,
    // as the page scrolls or resizes.
    const place = () => {
      if (!this._menu) return;
      const button = this._root.querySelector(`.chip[data-menu="${this._menu}"]`);
      if (!button) return;
      const r = button.getBoundingClientRect();
      const m = this._menuEl;
      m.style.minWidth = `${r.width}px`;
      m.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - m.offsetWidth - 8))}px`;
      const below = r.bottom + 4;
      m.style.top = `${below + m.offsetHeight > window.innerHeight - 8 ? Math.max(8, r.top - 4 - m.offsetHeight) : below}px`;
      this._placing = requestAnimationFrame(place);
    };
    place();
  }

  _closeMenu() {
    cancelAnimationFrame(this._placing);
    if (this._menuEl && this._menuEl.matches(":popover-open")) this._menuEl.hidePopover();
    this._menu = null;
    this._lastMenu = "";
  }

  disconnectedCallback() { this._closeMenu(); }
}

class ResideoThermostatNativeCard extends ResideoThermostatCard {
  static NATIVE = true;

  async _build() {
    // The built-in Mode/Fan features need the entity's lists, so wait for the first state.
    if (!this._hass.states[this._config.entity]) return;
    return super._build();
  }
}

// The hold status as a card feature, for this card and HA's own thermostat or tile cards:
// https://contributors.home-assistant.io/frontend/custom-ui/card-feature/
class ResideoHoldFeature extends ResideoBase {
  setConfig(config) {
    if (!config) throw new Error("Invalid configuration");
    this._config = config;
  }

  set context(context) { this._context = context; this._render(); }

  get _entityId() { return (this._context || {}).entity_id; }

  static getStubConfig() { return { type: "custom:resideo-hold-feature" }; }

  set hass(hass) {
    this._hass = hass;
    if (!this._root) {
      this._root = this.attachShadow({ mode: "open" });
      this._root.innerHTML = `<style>${FEATURE_STYLE}</style><div class="body"></div><dialog class="dlg"></dialog>`;
      this._setupDialog();
      // Keep a click from also reaching the card underneath, which would open more-info.
      this._root.addEventListener("click", (ev) => ev.stopPropagation());
    }
    this._render();
  }

  _render() {
    if (!this._root || !this._hass || !this._entityId) return;
    const st = this._hass.states[this._entityId];
    if (!st) return;
    const html = this._statusHtml(this._status(st), true);
    const body = this._root.querySelector(".body");
    if (html !== this._lastHtml) {
      body.innerHTML = html;
      this._lastHtml = html;
    }
    this._renderDialog(st);
  }
}

function isResideoClimate(hass, context) {
  const id = context && context.entity_id;
  const e = id && (hass.entities || {})[id];
  return Boolean(e && e.platform === "resideo" && id.startsWith("climate."));
}

window.customCards = window.customCards || [];
if (!customElements.get("resideo-thermostat-card")) {
  customElements.define("resideo-thermostat-card", ResideoThermostatCard);
  window.customCards.push({
    type: "resideo-thermostat-card",
    name: "Resideo thermostat",
    description: "Home Assistant's thermostat card with the T9's hold status, hold options, room priority, humidity, and T9-style Mode and Fan buttons.",
    preview: false,
  });
}
if (!customElements.get("resideo-thermostat-card-native")) {
  customElements.define("resideo-thermostat-card-native", ResideoThermostatNativeCard);
  window.customCards.push({
    type: "resideo-thermostat-card-native",
    name: "Resideo thermostat (native controls)",
    description: "The Resideo thermostat card with Home Assistant's own Mode and Fan controls, and the hold status as a card feature.",
    preview: false,
  });
}
if (!customElements.get("resideo-hold-feature")) {
  customElements.define("resideo-hold-feature", ResideoHoldFeature);
  window.customCardFeatures = window.customCardFeatures || [];
  window.customCardFeatures.push({
    type: "resideo-hold-feature",
    name: "Resideo hold status",
    isSupported: isResideoClimate,
    configurable: false,
  });
}
