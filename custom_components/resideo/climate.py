"""Climate platform for the Resideo integration — the thermostat entity.

Maps the consumer-API device shadow to a Home Assistant ``climate`` entity per
``resideo-api-spec.md`` §7: capability-driven modes/limits, single-setpoint Heat/Cool, an Auto
heat/cool **range** (``target_temperature_low``/``high``), fan modes, and **hold presets**
(``SetpointStatus`` via ``PUT hold``). EmergencyHeat has no HA HVAC mode, so it reads as Heat and
is toggled by a separate ``switch`` (see ``switch.py``).

Writes are optimistic: the consumer API is asynchronous (``202`` means *accepted*, not
*applied*) and the device shadow lags a few seconds, so a successful write is reflected in
the UI immediately and reconciled against later data (see ``OptimisticWriteMixin``).
"""

from __future__ import annotations

from datetime import time
from typing import Any

import voluptuous as vol
from homeassistant.components.climate import (
    ATTR_TARGET_TEMP_HIGH,
    ATTR_TARGET_TEMP_LOW,
    ClimateEntity,
    ClimateEntityFeature,
    HVACAction,
    HVACMode,
)
from homeassistant.components.climate.const import FAN_AUTO, FAN_ON, PRESET_NONE
from homeassistant.const import ATTR_TEMPERATURE, UnitOfTemperature
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError, ServiceValidationError
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers import entity_platform
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from .aioresideo import ResideoThermostat
from .aioresideo.const import (
    FAN_AUTO as RES_FAN_AUTO,
)
from .aioresideo.const import (
    FAN_CIRCULATE as RES_FAN_CIRCULATE,
)
from .aioresideo.const import (
    FAN_ON as RES_FAN_ON,
)
from .aioresideo.const import (
    SCHEDULE_TYPE_TIMED,
    SETPOINT_HOLD_UNTIL,
    SETPOINT_NO_HOLD,
    SETPOINT_PERMANENT_HOLD,
    SETPOINT_TEMPORARY_HOLD,
    SETPOINT_VACATION_HOLD,
    SYSTEM_SWITCH_AUTO,
    SYSTEM_SWITCH_COOL,
    SYSTEM_SWITCH_EMERGENCY_HEAT,
    SYSTEM_SWITCH_HEAT,
    SYSTEM_SWITCH_OFF,
)
from .aioresideo.exceptions import ResideoError
from .coordinator import ResideoConfigEntry, ResideoDataUpdateCoordinator
from .entity import OptimisticWriteMixin, ResideoEntity

# Writes are commands; serialize service calls per platform (reads are pure push).
PARALLEL_UPDATES = 1

# Resideo SystemSwitch <-> HA HVACMode. TODO: EmergencyHeat has no direct HA mode.
RESIDEO_TO_HVAC: dict[str, HVACMode] = {
    SYSTEM_SWITCH_OFF: HVACMode.OFF,
    SYSTEM_SWITCH_HEAT: HVACMode.HEAT,
    SYSTEM_SWITCH_COOL: HVACMode.COOL,
    SYSTEM_SWITCH_AUTO: HVACMode.HEAT_COOL,
}
HVAC_TO_RESIDEO: dict[HVACMode, str] = {v: k for k, v in RESIDEO_TO_HVAC.items()}

# Reported.OperationStatus.Mode -> HA HVACAction (current activity).
RESIDEO_TO_ACTION: dict[str, HVACAction] = {
    "EquipmentOff": HVACAction.IDLE,
    "Off": HVACAction.OFF,
    "Heat": HVACAction.HEATING,
    "Cool": HVACAction.COOLING,
}

# Hold presets <-> Reported.Setpoint.SetpointStatus (spec §4/§7). Reads cover every status;
# NoHold/PermanentHold/TemporaryHold are settable via `PUT hold {Status}` (all 202-verified).
# HoldUntil is settable with the next period as its end, like the T9's "Next Period" hold option
# (body from the First Alert app, unverified: see client.set_hold). VacationHold needs start/end
# dates + setpoints a plain preset can't supply, so it is shown read-only and rejected on set.
PRESET_PERMANENT_HOLD = "permanent_hold"
PRESET_TEMPORARY_HOLD = "temporary_hold"
PRESET_HOLD_UNTIL = "hold_until"
PRESET_VACATION = "vacation"

SERVICE_SET_HOLD_UNTIL = "set_hold_until"

RESIDEO_STATUS_TO_PRESET: dict[str, str] = {
    SETPOINT_NO_HOLD: PRESET_NONE,
    SETPOINT_PERMANENT_HOLD: PRESET_PERMANENT_HOLD,
    SETPOINT_TEMPORARY_HOLD: PRESET_TEMPORARY_HOLD,
    SETPOINT_HOLD_UNTIL: PRESET_HOLD_UNTIL,
    SETPOINT_VACATION_HOLD: PRESET_VACATION,
}
PRESET_TO_HOLD_STATUS: dict[str, str] = {
    PRESET_NONE: SETPOINT_NO_HOLD,
    PRESET_PERMANENT_HOLD: SETPOINT_PERMANENT_HOLD,
    PRESET_TEMPORARY_HOLD: SETPOINT_TEMPORARY_HOLD,
    PRESET_HOLD_UNTIL: SETPOINT_HOLD_UNTIL,
}
_SETTABLE_PRESETS: tuple[str, ...] = (PRESET_NONE, PRESET_PERMANENT_HOLD, PRESET_TEMPORARY_HOLD)
# A timed schedule's holds, as the T9 offers them: Remove Hold, Next Period, Permanently.
_TIMED_SCHEDULE_PRESETS: tuple[str, ...] = (PRESET_NONE, PRESET_HOLD_UNTIL, PRESET_PERMANENT_HOLD)

# HA has a fixed vocabulary of fan-mode constants (auto/on/off/low/.../diffuse) with no
# "circulate". fan_modes accepts arbitrary strings, though, so expose the Resideo label
# verbatim — the app shows "Circulate" — rather than mislabelling it as HA's "Diffuse".
FAN_CIRCULATE = "Circulate"

HA_TO_RESIDEO_FAN: dict[str, str] = {
    FAN_AUTO: RES_FAN_AUTO,
    FAN_ON: RES_FAN_ON,
    FAN_CIRCULATE: RES_FAN_CIRCULATE,
}
RESIDEO_TO_HA_FAN: dict[str, str] = {v: k for k, v in HA_TO_RESIDEO_FAN.items()}

# Display fan modes in the Resideo app's order (Auto, Circulate, On) rather than the
# device's reported Positions order (On, Auto, Circulate), for parity with the app.
_FAN_MODE_ORDER = [FAN_AUTO, FAN_CIRCULATE, FAN_ON]


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ResideoConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Set up Resideo climate entities."""
    coordinator = entry.runtime_data
    async_add_entities(ResideoClimate(coordinator, mac) for mac in coordinator.data)
    entity_platform.async_get_current_platform().async_register_entity_service(
        SERVICE_SET_HOLD_UNTIL, {vol.Required("until"): cv.time}, "async_set_hold_until"
    )


def _follows_timed_schedule(device: ResideoThermostat) -> bool:
    return device.schedule_type == SCHEDULE_TYPE_TIMED


def _until(hold_until: str | None) -> dict[str, str]:
    """The ``hold_until`` argument of a write, only when there is one."""
    return {} if hold_until is None else {"hold_until": hold_until}


class ResideoClimate(OptimisticWriteMixin, ResideoEntity, ClimateEntity):
    """A Resideo thermostat as an HA climate entity."""

    _attr_name = None  # use the device's own name
    _attr_translation_key = "thermostat"  # for preset_mode state-attribute translations
    # API payloads are always °F, regardless of the thermostat's display unit or the app's
    # unit preference (see ResideoConfiguration.temperature_units) — HA converts for display.
    _attr_native_temperature_unit = UnitOfTemperature.FAHRENHEIT
    # Fallbacks when /configuration is unavailable. Normally hvac_modes / fan_modes /
    # min_temp / max_temp are derived live from device capabilities below.
    _attr_hvac_modes = [HVACMode.OFF, HVACMode.HEAT, HVACMode.COOL, HVACMode.HEAT_COOL]
    _attr_fan_modes = _FAN_MODE_ORDER

    def __init__(
        self, coordinator: ResideoDataUpdateCoordinator, mac: str
    ) -> None:
        super().__init__(coordinator, mac)
        self._attr_unique_id = f"{mac}_climate"

    def _confirmed_values(self) -> dict[str, Any] | None:
        """Current device truth per optimistic facet (see ``OptimisticWriteMixin``)."""
        device = self.device
        if device is None:
            return None
        return {
            "hvac_mode": (
                HVACMode.HEAT
                if device.system_switch == SYSTEM_SWITCH_EMERGENCY_HEAT
                else RESIDEO_TO_HVAC.get(device.system_switch)
            ),
            "fan_mode": (
                RESIDEO_TO_HA_FAN.get(device.fan_position)
                if device.fan_position is not None
                else None
            ),
            "cool_setpoint": device.cool_setpoint,
            "heat_setpoint": device.heat_setpoint,
            "preset": RESIDEO_STATUS_TO_PRESET.get(device.setpoint_status),
        }

    @property
    def supported_features(self) -> ClimateEntityFeature:
        # In Auto (heat_cool) the user sets a heat/cool range; in Heat/Cool a single setpoint.
        features = ClimateEntityFeature(0)
        if self.hvac_mode == HVACMode.HEAT_COOL:
            features |= ClimateEntityFeature.TARGET_TEMPERATURE_RANGE
        else:
            features |= ClimateEntityFeature.TARGET_TEMPERATURE
        # Only claim FAN_MODE when the device has a controllable fan (fan_modes is None on a
        # fanless system whose /configuration reports no positions).
        if self.fan_modes:
            features |= ClimateEntityFeature.FAN_MODE
        # HA only exposes the climate.turn_on/turn_off/toggle services when these features are
        # declared; the ClimateEntity defaults (off -> OFF, on -> first non-off mode) apply.
        modes = self.hvac_modes
        if HVACMode.OFF in modes and len(modes) > 1:
            features |= ClimateEntityFeature.TURN_OFF | ClimateEntityFeature.TURN_ON
        # Only expose the hold-preset control when there's an actual choice. With the schedule off
        # the sole reachable status is PermanentHold, so a single-option selector is hidden.
        if len(self.preset_modes) > 1:
            features |= ClimateEntityFeature.PRESET_MODE
        return features

    # --- capabilities derived from /configuration (with safe fallbacks) ------
    @property
    def hvac_modes(self) -> list[HVACMode]:
        config = self.configuration
        caps = config.system_switch_capabilities if config else []
        present = {RESIDEO_TO_HVAC[c] for c in caps if c in RESIDEO_TO_HVAC}
        if not present:
            return self._attr_hvac_modes
        # Stable display order; OFF is always offered.
        ordered = [
            m
            for m in (HVACMode.OFF, HVACMode.HEAT, HVACMode.COOL, HVACMode.HEAT_COOL)
            if m in present
        ]
        if HVACMode.OFF not in ordered:
            ordered.insert(0, HVACMode.OFF)
        return ordered

    @property
    def fan_modes(self) -> list[str] | None:
        config = self.configuration
        if config is None or not config.reported:
            return self._attr_fan_modes  # no capability data -> sane defaults
        modes = [RESIDEO_TO_HA_FAN[p] for p in config.fan_positions if p in RESIDEO_TO_HA_FAN]
        if not modes:
            return None  # fanless system -> no fan control (FAN_MODE feature is gated on this)
        rank = {m: i for i, m in enumerate(_FAN_MODE_ORDER)}
        return sorted(modes, key=lambda m: rank.get(m, len(rank)))

    @property
    def min_temp(self) -> float:
        config = self.configuration
        if config:
            mins = [
                v
                for v in (config.min_heat_setpoint, config.min_cool_setpoint)
                if v is not None
            ]
            if mins:
                return min(mins)
        return super().min_temp

    @property
    def max_temp(self) -> float:
        config = self.configuration
        if config:
            maxs = [
                v
                for v in (config.max_heat_setpoint, config.max_cool_setpoint)
                if v is not None
            ]
            if maxs:
                return max(maxs)
        return super().max_temp

    @property
    def native_current_temperature(self) -> float | None:
        return self.device.indoor_temperature if self.device else None

    @property
    def current_humidity(self) -> int | None:
        return self.device.indoor_humidity if self.device else None

    @property
    def hvac_mode(self) -> HVACMode | None:
        if "hvac_mode" in self._optimistic:
            return self._optimistic["hvac_mode"]
        if not self.device:
            return None
        # EmergencyHeat has no HA HVAC mode -> show Heat (the emergency_heat switch carries the
        # distinction and is how it's toggled).
        if self.device.system_switch == SYSTEM_SWITCH_EMERGENCY_HEAT:
            return HVACMode.HEAT
        return RESIDEO_TO_HVAC.get(self.device.system_switch)

    @property
    def hvac_action(self) -> HVACAction | None:
        device = self.device
        if not device:
            return None
        action = RESIDEO_TO_ACTION.get(device.operation_mode)
        if self.hvac_mode == HVACMode.OFF:
            action = HVACAction.OFF
        # Not calling for heat/cool but the blower is running (fan On/Circulate) -> FAN.
        if action in (HVACAction.IDLE, HVACAction.OFF) and device.fan_request:
            return HVACAction.FAN
        return action

    @property
    def native_target_temperature(self) -> float | None:
        device = self.device
        if not device:
            return None
        if self.hvac_mode == HVACMode.COOL:
            return self._optimistic.get("cool_setpoint", device.cool_setpoint)
        if self.hvac_mode == HVACMode.HEAT:
            return self._optimistic.get("heat_setpoint", device.heat_setpoint)
        return None  # HEAT_COOL uses native_target_temperature_low/high

    @property
    def native_target_temperature_low(self) -> float | None:
        device = self.device
        if not device or self.hvac_mode != HVACMode.HEAT_COOL:
            return None
        return self._optimistic.get("heat_setpoint", device.heat_setpoint)

    @property
    def native_target_temperature_high(self) -> float | None:
        device = self.device
        if not device or self.hvac_mode != HVACMode.HEAT_COOL:
            return None
        return self._optimistic.get("cool_setpoint", device.cool_setpoint)

    # Home Assistant 2026.11 renamed the temperature members to native_*. Earlier cores read
    # only the old names, kept here as aliases; from 2026.11 the native ones win when a class
    # provides both.
    _attr_temperature_unit = _attr_native_temperature_unit
    current_temperature = native_current_temperature
    target_temperature = native_target_temperature
    target_temperature_low = native_target_temperature_low
    target_temperature_high = native_target_temperature_high

    @property
    def preset_mode(self) -> str | None:
        if "preset" in self._optimistic:
            return self._optimistic["preset"]
        device = self.device
        if not device:
            return None
        return RESIDEO_STATUS_TO_PRESET.get(device.setpoint_status)

    @property
    def preset_modes(self) -> list[str]:
        # Holds only matter with a schedule to return to. With the schedule OFF the device stays
        # in PermanentHold — NoHold/TemporaryHold are 202-accepted but don't apply (verified live)
        # — so offer only the current (read-only) preset then. With a schedule on, expose the
        # settable holds. The current status is always included so HA never warns on display
        # (e.g. vacation / hold-until, which are read-only).
        device = self.device
        if not (device and device.schedule_enabled):
            modes = [PRESET_PERMANENT_HOLD]
        elif _follows_timed_schedule(device):
            modes = list(_TIMED_SCHEDULE_PRESETS)
        else:
            modes = list(_SETTABLE_PRESETS)
        current = self.preset_mode
        if current and current not in modes:
            modes.append(current)
        return modes

    @property
    def fan_mode(self) -> str | None:
        if "fan_mode" in self._optimistic:
            return self._optimistic["fan_mode"]
        if not self.device or self.device.fan_position is None:
            return None
        return RESIDEO_TO_HA_FAN.get(self.device.fan_position)

    def _write_hold(self) -> tuple[str, str | None]:
        """The ``SetpointStatus`` (and HoldUntil end) a setpoint write should carry.

        App parity, from the First Alert app's own rule (Android 3.0.5, decompiled; see the
        fork's docs/first-alert-app-hold-api.md). Following a timed schedule, a change holds
        until the next period, as on the touchscreen. A change during such a hold keeps its end.
        Other schedules use a TemporaryHold, and with the schedule off it is a PermanentHold.
        The HoldUntil writes are unverified until a device confirms one.
        """
        device = self.device
        if not (device and device.schedule_enabled):
            return SETPOINT_PERMANENT_HOLD, None
        status = device.setpoint_status
        if status == SETPOINT_HOLD_UNTIL and device.hold_until:
            return SETPOINT_HOLD_UNTIL, device.hold_until
        if status == SETPOINT_NO_HOLD and _follows_timed_schedule(device) and device.next_period_time:
            return SETPOINT_HOLD_UNTIL, device.next_period_time
        if status in (SETPOINT_NO_HOLD, SETPOINT_TEMPORARY_HOLD):
            return SETPOINT_TEMPORARY_HOLD, None
        return SETPOINT_PERMANENT_HOLD, None

    async def async_set_temperature(self, **kwargs: Any) -> None:
        """Set a single target (Heat/Cool) or a heat/cool range (Auto)."""
        if self.hvac_mode == HVACMode.HEAT_COOL:
            await self._async_set_range(
                kwargs.get(ATTR_TARGET_TEMP_LOW), kwargs.get(ATTR_TARGET_TEMP_HIGH)
            )
            return
        temperature = kwargs.get(ATTR_TEMPERATURE)
        if temperature is None:
            return
        mode = self.hvac_mode
        if mode == HVACMode.COOL:
            key = "cool_setpoint"
            call = self.coordinator.api.async_set_cool_setpoint
        elif mode == HVACMode.HEAT:
            key = "heat_setpoint"
            call = self.coordinator.api.async_set_heat_setpoint
        else:
            raise ServiceValidationError(
                "Set an HVAC mode (heat/cool/auto) before setting a target temperature."
            )
        status, hold_until = self._write_hold()
        try:
            await call(self._mac, temperature, status=status, **_until(hold_until))
        except ResideoError as err:
            raise HomeAssistantError(f"Failed to set temperature: {err}") from err
        await self._async_post_write(
            {key: temperature, "preset": RESIDEO_STATUS_TO_PRESET.get(status)}
        )

    async def _async_set_range(
        self, low: float | None, high: float | None
    ) -> None:
        """Write the Auto-mode heat (low) and cool (high) setpoints."""
        if low is None and high is None:
            return
        status, hold_until = self._write_hold()
        optimistic: dict[str, Any] = {"preset": RESIDEO_STATUS_TO_PRESET.get(status)}
        try:
            # Cool first, then heat — both are independent PUTs (each 202-verified).
            if high is not None:
                await self.coordinator.api.async_set_cool_setpoint(
                    self._mac, high, status=status, **_until(hold_until)
                )
                optimistic["cool_setpoint"] = high
            if low is not None:
                await self.coordinator.api.async_set_heat_setpoint(
                    self._mac, low, status=status, **_until(hold_until)
                )
                optimistic["heat_setpoint"] = low
        except ResideoError as err:
            raise HomeAssistantError(f"Failed to set temperature range: {err}") from err
        await self._async_post_write(optimistic)

    async def async_set_preset_mode(self, preset_mode: str) -> None:
        """Set the hold status (PUT hold).

        Vacation is read-only (needs dates). NoHold/TemporaryHold/HoldUntil need an enabled
        schedule — without one the device just stays in PermanentHold (verified live), so
        reject them rather than issue a silent no-op write. HoldUntil ends at the next period.
        """
        status = PRESET_TO_HOLD_STATUS.get(preset_mode)
        if status is None:
            raise ServiceValidationError(
                f"Preset '{preset_mode}' can't be set from Home Assistant — vacation needs "
                "dates; set it in the Resideo app."
            )
        device = self.device
        if preset_mode != PRESET_PERMANENT_HOLD and not (device and device.schedule_enabled):
            raise ServiceValidationError(
                f"Preset '{preset_mode}' needs the schedule enabled — with the schedule off the "
                "thermostat stays in a permanent hold."
            )
        hold_until = None
        if status == SETPOINT_HOLD_UNTIL:
            hold_until = self._next_period_end()
        try:
            await self.coordinator.api.async_set_hold(self._mac, status, **_until(hold_until))
        except ResideoError as err:
            raise HomeAssistantError(f"Failed to set hold: {err}") from err
        await self._async_post_write({"preset": preset_mode})

    def _next_period_end(self) -> str:
        """The end of a hold until the next period: "HH:MM:SS", thermostat-local.

        NextPeriodTime is the next period only while following the schedule; during a
        HoldUntil it is the hold's end (tests/homes/t9-wifi-4-sensors.json), and nothing shows
        what it is during other holds, so those are refused.
        """
        device = self.device
        if device and device.setpoint_status == SETPOINT_HOLD_UNTIL and device.hold_until:
            return device.hold_until
        if device and device.setpoint_status == SETPOINT_NO_HOLD and device.next_period_time:
            return device.next_period_time
        raise ServiceValidationError(
            "Hold until the next period needs the thermostat following its schedule — remove "
            "the current hold first."
        )

    async def async_set_hold_until(self, until: time) -> None:
        """Hold the current setpoints until a time of day (the T9's "A Specific Time…").

        ``until`` is thermostat-local; the thermostat holds at most until it next comes round.
        """
        device = self.device
        if not (device and device.schedule_enabled):
            raise ServiceValidationError(
                "A hold until a time needs the schedule enabled — with the schedule off the "
                "thermostat stays in a permanent hold."
            )
        try:
            await self.coordinator.api.async_set_hold(
                self._mac, SETPOINT_HOLD_UNTIL, hold_until=f"{until.hour:02d}:{until.minute:02d}:00"
            )
        except ResideoError as err:
            raise HomeAssistantError(f"Failed to set hold: {err}") from err
        await self._async_post_write({"preset": PRESET_HOLD_UNTIL})

    async def async_set_hvac_mode(self, hvac_mode: HVACMode) -> None:
        """Set the system mode."""
        mode = HVAC_TO_RESIDEO.get(hvac_mode)
        if mode is None:
            raise ServiceValidationError(f"Unsupported HVAC mode: {hvac_mode}")
        try:
            await self.coordinator.api.async_set_system_switch(self._mac, mode)
        except ResideoError as err:
            raise HomeAssistantError(f"Failed to set HVAC mode: {err}") from err
        await self._async_post_write({"hvac_mode": hvac_mode})

    async def async_set_fan_mode(self, fan_mode: str) -> None:
        """Set the fan mode."""
        position = HA_TO_RESIDEO_FAN.get(fan_mode)
        if position is None:
            raise ServiceValidationError(f"Unsupported fan mode: {fan_mode}")
        try:
            await self.coordinator.api.async_set_fan(self._mac, position)
        except ResideoError as err:
            raise HomeAssistantError(f"Failed to set fan mode: {err}") from err
        await self._async_post_write({"fan_mode": fan_mode})
