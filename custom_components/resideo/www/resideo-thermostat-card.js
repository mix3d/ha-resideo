/*
 * Resideo thermostat card: Home Assistant's own thermostat card, plus what a T9 shows around it.
 *
 *   type: custom:resideo-thermostat-card
 *   entity: climate.<thermostat>
 *
 * Adds, from the Resideo integration's entities on the same device: the room-priority count and
 * humidity at the dial's top corners; the status under the -/+ buttons ("Following Schedule", "Using Away
 * Settings" when geofenced, "Schedule Off",
 * or a pill that opens Hold Options / Vacation Hold like the T9); an upcoming-vacation note; and
 * compact Mode and Fan buttons that open pickers.
 */

const HEAT = "var(--state-climate-heat-color, #ff8100)";
const COOL = "var(--state-climate-cool-color, #2b9af9)";

const MODES = {
  heat_cool: { label: "Auto", icon: "mdi:sun-snowflake-variant", color: "var(--state-climate-heat_cool-color, #008000)",
    desc: "Switches between heating and cooling automatically" },
  heat: { label: "Heat", icon: "mdi:fire", color: HEAT },
  cool: { label: "Cool", icon: "mdi:snowflake", color: COOL },
  off: { label: "Off", icon: "mdi:power", color: "var(--secondary-text-color)",
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

const STYLE = `
  :host { display: block; }
  ha-card { position: relative; }
  .inner { --ha-card-background: transparent; --ha-card-border-width: 0; --ha-card-box-shadow: none; --ha-card-border-color: transparent; }
  .corner { position: absolute; top: 52px; display: flex; align-items: center; gap: 6px;
    font-size: 22px; color: var(--primary-text-color); pointer-events: none; }
  .corner.left { left: 18px; } .corner.right { right: 18px; }
  .corner ha-icon { --mdc-icon-size: 24px; color: var(--secondary-text-color); }
  .status { display: flex; justify-content: center; align-items: center; min-height: 44px; margin: -6px 16px 0; }
  .status .plain { font-size: 15px; color: var(--primary-text-color); }
  .status .plain.off { display: flex; align-items: center; gap: 8px; color: var(--secondary-text-color); }
  .status .plain.off ha-icon { --mdc-icon-size: 20px; }
  .caption { text-align: center; margin-top: 2px; font-size: 13px; color: var(--secondary-text-color); }
  button { font: inherit; cursor: pointer; }
  .pill { min-height: 42px; padding: 0 20px; border-radius: 21px; border: 1.5px solid var(--primary-text-color);
    background: transparent; color: var(--primary-text-color); font-size: 15px; font-weight: 500; }
  .note { display: flex; align-items: center; gap: 8px; margin: 10px 16px 0; padding: 8px 12px; border-radius: 10px;
    background: var(--secondary-background-color); font-size: 13px; color: var(--primary-text-color); }
  .note ha-icon { --mdc-icon-size: 18px; color: var(--secondary-text-color); }
  .chips { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin: 12px 16px 16px; }
  .chip { min-height: 44px; border-radius: 10px; border: none; display: flex; align-items: center; justify-content: center;
    gap: 8px; font-size: 14px; font-weight: 500; background: var(--secondary-background-color); color: var(--primary-text-color); }
  .chip ha-icon { --mdc-icon-size: 20px; }
  /* A native modal <dialog>: shown in the page's top layer, so it sits over the whole dashboard and
     is never rebuilt by the card's own updates. */
  dialog.dlg { width: min(360px, calc(100vw - 32px)); max-height: calc(100vh - 32px); box-sizing: border-box;
    padding: 16px 18px 18px; border: none; border-radius: 16px; overflow: auto;
    background: var(--card-background-color, #1c1c1c); color: var(--primary-text-color);
    font-family: var(--ha-font-family-body, Roboto, system-ui, sans-serif); box-shadow: 0 8px 24px rgba(0,0,0,0.4); }
  dialog.dlg[open] { display: flex; flex-direction: column; gap: 10px; }
  dialog.dlg::backdrop { background: rgba(0,0,0,0.55); }
  .dlg .head { display: flex; align-items: center; gap: 6px; font-size: 18px; font-weight: 500; }
  .dlg .head button { width: 40px; height: 40px; border: none; background: transparent; color: inherit; font-size: 24px; }
  .dlg p { margin: 0 0 4px; text-align: center; font-size: 14px; line-height: 1.45; color: var(--secondary-text-color); }
  .opt { min-height: 44px; border-radius: 22px; border: 1.5px solid var(--primary-text-color); background: transparent;
    color: var(--primary-text-color); font-size: 15px; font-weight: 500; }
  .opt:disabled { opacity: 0.4; cursor: not-allowed; }
  hr { border: none; border-top: 1px solid var(--divider-color); margin: 4px 0; width: 100%; }
  .row { display: flex; gap: 8px; align-items: flex-end; }
  .row label { flex: 1; display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--secondary-text-color); }
  .row input { min-height: 44px; padding: 0 10px; border-radius: 10px; border: 1px solid var(--divider-color);
    background: var(--secondary-background-color); color: var(--primary-text-color); font-size: 15px; color-scheme: light dark; }
  .go { min-height: 44px; padding: 0 18px; border-radius: 22px; border: none; background: var(--primary-color); color: var(--text-primary-color, #fff); font-weight: 500; }
  .item { min-height: 48px; padding: 6px 12px; border-radius: 12px; border: 1.5px solid transparent; background: transparent;
    color: var(--primary-text-color); display: flex; align-items: center; gap: 12px; text-align: left; }
  .item.on { border-color: var(--primary-text-color); }
  .item ha-icon { --mdc-icon-size: 28px; flex-shrink: 0; }
  .item small { display: block; font-size: 12px; color: var(--secondary-text-color); }
  .error { color: var(--error-color, #db4437); font-size: 13px; text-align: center; }
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

class ResideoThermostatCard extends HTMLElement {
  setConfig(config) {
    if (!config || !config.entity || !config.entity.startsWith("climate.")) {
      throw new Error("Set 'entity' to a Resideo climate entity");
    }
    this._config = config;
    this._dialog = null;
    this._error = "";
    if (this._inner) this._inner.setConfig(this._innerConfig());
  }

  // HA's own thermostat card, as is: the room temperature as the big number (its "show current
  // as primary" option, on unless the card config turns it off).
  _innerConfig() {
    return { type: "thermostat", entity: this._config.entity,
      show_current_as_primary: this._config.show_current_as_primary ?? true };
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
    this._root.innerHTML = `<style>${STYLE}</style><ha-card><div class="inner"></div><div class="extras"></div></ha-card><dialog class="dlg"></dialog>`;
    this._dlg = this._root.querySelector("dialog");
    this._root.addEventListener("click", (ev) => this._onClick(ev));
    this._root.addEventListener("input", (ev) => { if (ev.target.name === "until") this._until = ev.target.value; });
    // Esc closes the dialog natively; keep the card's idea of it in step.
    this._dlg.addEventListener("close", () => { this._dialog = null; this._error = ""; this._lastDialog = ""; });
    const helpers = await window.loadCardHelpers();
    this._inner = await helpers.createCardElement(this._innerConfig());
    this._inner.hass = this._hass;
    this._root.querySelector(".inner").appendChild(this._inner);
    this._hideMoreInfo();
  }

  // Entities of the same device, by the integration's translation key (entity_id as a fallback).
  _sibling(key, domain = "sensor") {
    const ents = this._hass.entities || {};
    const me = ents[this._config.entity];
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

  _render() {
    if (!this._root || !this._hass || !this._config) return;
    const st = this._hass.states[this._config.entity];
    const extras = this._root.querySelector(".extras");
    if (!st) { extras.innerHTML = `<div class="note">Entity not found: ${esc(this._config.entity)}</div>`; return; }
    const a = st.attributes;
    const preset = a.preset_mode || "none";
    const rooms = this._sibling("priority_rooms");
    const holdUntil = this._time("hold_until");
    const vStart = this._time("vacation_start");
    const vEnd = this._time("vacation_end");

    // Schedule mode, as the First Alert app reads it (status builder 0xfac660; T9 manual p. 16).
    const schedule = this._sibling("schedule", "switch");
    const scheduleOff = schedule && schedule.state === "off";
    const type = (this._sibling("schedule_type") || {}).state || "";
    this._geo = type.startsWith("Geofenced");
    const period = PERIOD_WORD[(this._sibling("schedule_period") || {}).state];

    let status;
    if (preset === "vacation") status = { pill: "Vacation Hold", dialog: "vacation" };
    // With the schedule off the T9 holds permanently: there is nothing to return to.
    else if (scheduleOff) status = { off: "Schedule Off" };
    else if (preset === "hold_until") status = { pill: holdUntil ? `Hold until ${fmtTime(holdUntil)}` : "Hold until next period", dialog: "hold" };
    else if (preset === "permanent_hold") status = { pill: "Permanent Hold", dialog: "hold" };
    else if (preset === "temporary_hold") {
      // A geofenced hold lasts until someone crosses the geofence (T9 manual p. 16).
      const caption = !this._geo ? "" : period === "Away" ? "Until someone arrives home" : "Until everyone leaves";
      status = { pill: "Temporary Hold", dialog: "hold", caption };
    }
    else if (st.state === "off") status = { plain: "" };
    // No preset stands for it; the raw status sensor does.
    else if ((this._sibling("setpoint_status") || {}).state === "StandBySetpoint") status = { plain: "Standby Setpoints Active" };
    else if (this._geo && period) status = { plain: `Using ${period} Settings` };
    else status = { plain: "Following Schedule" };

    const upcoming = preset !== "vacation" && vStart && vStart > new Date() && vEnd
      ? `Upcoming vacation · ${fmtDay(vStart)}, ${fmtTime(vStart)} – ${fmtDay(vEnd)}, ${fmtTime(vEnd)}` : "";
    const mode = MODES[st.state] || { label: st.state, icon: "mdi:thermostat", color: "var(--primary-text-color)" };
    const fan = FANS[a.fan_mode] || { label: a.fan_mode || "—", icon: "mdi:fan" };
    const humidity = a.current_humidity;
    // The Mode button shows what the system is doing: orange while heating, blue while cooling.
    const running = a.hvac_action === "heating" ? HEAT : a.hvac_action === "cooling" ? COOL : null;

    let html = "";
    if (rooms && !isNaN(Number(rooms.state))) {
      html += `<div class="corner left" title="Rooms in the priority average"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true" style="color: var(--secondary-text-color)"><path d="M3 11 12 4l9 7v9H3z"></path><rect x="8" y="11" width="4" height="4" fill="currentColor" stroke="none"></rect><rect x="12" y="15" width="4" height="4" fill="currentColor" stroke="none"></rect></svg><span>${esc(rooms.state)}</span></div>`;
    }
    if (humidity !== undefined && humidity !== null) {
      html += `<div class="corner right" title="Indoor humidity"><ha-icon icon="mdi:water-outline"></ha-icon><span>${esc(humidity)}%</span></div>`;
    }
    const statusHtml = status.pill
      ? `<button class="pill" data-act="open" data-dialog="${status.dialog}">${esc(status.pill)}</button>`
      : status.off
        ? `<span class="plain off"><ha-icon icon="mdi:calendar-remove-outline"></ha-icon>${esc(status.off)}</span>`
        : `<span class="plain">${esc(status.plain)}</span>`;
    html += `<div class="status">${statusHtml}</div>`;
    if (status.caption) html += `<div class="caption">${esc(status.caption)}</div>`;
    if (upcoming) html += `<div class="note"><ha-icon icon="mdi:calendar-clock"></ha-icon><span>${esc(upcoming)}</span></div>`;
    html += `<div class="chips">
      <button class="chip" data-act="open" data-dialog="mode" aria-label="Mode ${esc(mode.label)}, change"${running ? ` style="background: color-mix(in srgb, ${running} 20%, transparent)"` : ""}><ha-icon icon="${mode.icon}" style="color:${running || "var(--secondary-text-color)"}"></ha-icon>${esc(mode.label)}</button>
      <button class="chip" data-act="open" data-dialog="fan" aria-label="Fan ${esc(fan.label)}, change"><ha-icon icon="${fan.icon}"></ha-icon>Fan · ${esc(fan.label)}</button>
    </div>`;
    if (html !== this._lastHtml) {
      extras.innerHTML = html;
      this._lastHtml = html;
    }
    this._renderDialog(st, vEnd, preset);
  }

  // The open dialog follows the thermostat (someone may change it from the app, the device or
  // another Home Assistant user meanwhile) without being rebuilt unless what it shows changed,
  // and closes itself when what it is about has gone.
  _renderDialog(st, vEnd, preset) {
    const dlg = this._dlg;
    if (this._dialog === "vacation" && preset !== "vacation") this._dialog = null;
    const body = this._dialog ? this._dialogBody(st, vEnd) : "";
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

  _dialogBody(st, vEnd) {
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
      const until = vEnd ? `${vEnd.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })} at ${fmtTime(vEnd)}` : "its end";
      body = `${head("Vacation Hold")}<p>Vacation mode is in effect until ${esc(until)}</p>
        <button class="opt" data-act="end-vacation">End Vacation</button>`;
    } else if (d === "mode") {
      const modes = MODE_ORDER.filter((m) => (st.attributes.hvac_modes || []).includes(m));
      body = `${head("Mode")}` + modes.map((m) => `<button class="item ${m === st.state ? "on" : ""}" data-act="mode" data-value="${m}">
        <ha-icon icon="${MODES[m].icon}" style="color:${MODES[m].color}"></ha-icon><span>${MODES[m].label}${MODES[m].desc ? `<small>${MODES[m].desc}</small>` : ""}</span></button>`).join("");
    } else if (d === "fan") {
      body = `${head("Fan")}` + (st.attributes.fan_modes || []).map((f) => {
        const info = FANS[f] || { label: f, icon: "mdi:fan" };
        return `<button class="item ${f === st.attributes.fan_mode ? "on" : ""}" data-act="fan" data-value="${esc(f)}"><ha-icon icon="${info.icon}"></ha-icon><span>${esc(info.label)}</span></button>`;
      }).join("");
    }
    return `${body}${err}`;
  }

  async _call(domain, service, data) {
    try {
      await this._hass.callService(domain, service, { entity_id: this._config.entity, ...data });
      this._dialog = null;
      this._error = "";
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
}

if (!customElements.get("resideo-thermostat-card")) {
  customElements.define("resideo-thermostat-card", ResideoThermostatCard);
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: "resideo-thermostat-card",
    name: "Resideo thermostat",
    description: "Home Assistant's thermostat card with the T9's hold status, hold options, room priority and humidity.",
    preview: false,
  });
}
