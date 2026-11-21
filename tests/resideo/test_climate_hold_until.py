"""Holds that end at a time, written the way the First Alert app writes them.

The device side comes from tests/homes/t9-wifi-4-sensors.json: a T9 on a timed schedule, read
during a touchscreen hold until 05:00, plus the NoHold push that ended an earlier hold (next
period 17:00). The bodies the integration sends (HoldUntil "HH:MM:00") are the First Alert
app's, decompiled; no device has confirmed one yet.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock

import pytest
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ServiceValidationError
from pytest_homeassistant.common import MockConfigEntry

from custom_components.resideo.aioresideo import ResideoLiveFeed
from tests.homes import captured_pushes, load_home

from .conftest import advance_time, eid, home_api, setup_integration

HOME = "t9-wifi-4-sensors"


def _no_hold_push(device: dict[str, Any]) -> dict[str, Any]:
    return next(v for n, v in captured_pushes(device) if n == "Setpoint" and v["Status"] == "NoHold")


async def _setup(
    hass: HomeAssistant, entry: MockConfigEntry, *, following_schedule: bool
) -> tuple[AsyncMock, str]:
    home = load_home(HOME)
    api = home_api(home)
    await setup_integration(hass, entry, api)
    mac = api.macs[0]
    if following_schedule:
        api.streams[0].on_event(ResideoLiveFeed(mac, "Setpoint", _no_hold_push(home["data"]["devices"][0])))
        await advance_time(hass, 1)
    return api, mac


async def test_change_while_following_a_timed_schedule_holds_until_the_next_period(
    hass: HomeAssistant, mock_config_entry: MockConfigEntry
) -> None:
    api, mac = await _setup(hass, mock_config_entry, following_schedule=True)
    climate_id = eid(hass, "climate", f"{mac}_climate")
    assert hass.states.get(climate_id).attributes["preset_mode"] == "none"

    await hass.services.async_call(
        "climate", "set_temperature", {"entity_id": climate_id, "temperature": 65}, blocking=True
    )
    api.async_set_heat_setpoint.assert_awaited_once_with(
        mac, 65, status="HoldUntil", hold_until="17:00:00"
    )
    assert hass.states.get(climate_id).attributes["preset_mode"] == "hold_until"


async def test_change_during_a_hold_until_keeps_its_end(
    hass: HomeAssistant, mock_config_entry: MockConfigEntry
) -> None:
    """The bug seen live: this used to turn the 05:00 hold into a permanent one."""
    api, mac = await _setup(hass, mock_config_entry, following_schedule=False)
    climate_id = eid(hass, "climate", f"{mac}_climate")
    assert hass.states.get(climate_id).attributes["preset_mode"] == "hold_until"

    await hass.services.async_call(
        "climate", "set_temperature", {"entity_id": climate_id, "temperature": 63}, blocking=True
    )
    api.async_set_heat_setpoint.assert_awaited_once_with(
        mac, 63, status="HoldUntil", hold_until="05:00:00"
    )


async def test_timed_schedule_offers_the_t9_hold_options(
    hass: HomeAssistant, mock_config_entry: MockConfigEntry
) -> None:
    api, mac = await _setup(hass, mock_config_entry, following_schedule=True)
    climate_id = eid(hass, "climate", f"{mac}_climate")
    assert hass.states.get(climate_id).attributes["preset_modes"] == [
        "none", "hold_until", "permanent_hold"
    ]

    await hass.services.async_call(
        "climate", "set_preset_mode", {"entity_id": climate_id, "preset_mode": "hold_until"},
        blocking=True,
    )
    api.async_set_hold.assert_awaited_once_with(mac, "HoldUntil", hold_until="17:00:00")


async def test_next_period_replaces_a_permanent_hold(
    hass: HomeAssistant, mock_config_entry: MockConfigEntry
) -> None:
    """During a PermanentHold, NextPeriodTime is still the next schedule period."""
    home = load_home(HOME)
    setpoint = home["data"]["devices"][0]["shadow"]["Reported"]["Setpoint"]
    setpoint["SetpointStatus"] = "PermanentHold"
    setpoint["NextPeriodTime"] = "17:00:00"
    api = home_api(home)
    await setup_integration(hass, mock_config_entry, api)
    climate_id = eid(hass, "climate", f"{api.macs[0]}_climate")

    await hass.services.async_call(
        "climate", "set_preset_mode", {"entity_id": climate_id, "preset_mode": "hold_until"},
        blocking=True,
    )
    api.async_set_hold.assert_awaited_once_with(api.macs[0], "HoldUntil", hold_until="17:00:00")


async def test_next_period_during_a_vacation_is_refused(
    hass: HomeAssistant, mock_config_entry: MockConfigEntry
) -> None:
    """Nothing shows what NextPeriodTime means during a vacation."""
    api = home_api(load_home("t9-wifi-vacation"))
    await setup_integration(hass, mock_config_entry, api)
    climate_id = eid(hass, "climate", f"{api.macs[0]}_climate")

    with pytest.raises(ServiceValidationError):
        await hass.services.async_call(
            "climate", "set_preset_mode", {"entity_id": climate_id, "preset_mode": "hold_until"},
            blocking=True,
        )
    api.async_set_hold.assert_not_awaited()


async def test_set_hold_until_a_specific_time(
    hass: HomeAssistant, mock_config_entry: MockConfigEntry
) -> None:
    api, mac = await _setup(hass, mock_config_entry, following_schedule=True)
    climate_id = eid(hass, "climate", f"{mac}_climate")

    await hass.services.async_call(
        "resideo", "set_hold_until", {"entity_id": climate_id, "until": "05:30"}, blocking=True
    )
    api.async_set_hold.assert_awaited_once_with(mac, "HoldUntil", hold_until="05:30:00")
    assert hass.states.get(climate_id).attributes["preset_mode"] == "hold_until"


async def test_end_vacation(hass: HomeAssistant, mock_config_entry: MockConfigEntry) -> None:
    home = load_home("t9-wifi-vacation")
    api = home_api(home)
    await setup_integration(hass, mock_config_entry, api)
    mac = api.macs[0]
    climate_id = eid(hass, "climate", f"{mac}_climate")

    await hass.services.async_call("resideo", "end_vacation", {"entity_id": climate_id}, blocking=True)
    api.async_set_vacation_enabled.assert_awaited_once_with(
        mac, home["data"]["devices"][0]["shadow"]["Reported"]["VacationHold"], False
    )


async def test_end_vacation_without_one_is_refused(
    hass: HomeAssistant, mock_config_entry: MockConfigEntry
) -> None:
    api, mac = await _setup(hass, mock_config_entry, following_schedule=True)
    with pytest.raises(ServiceValidationError):
        await hass.services.async_call(
            "resideo", "end_vacation", {"entity_id": eid(hass, "climate", f"{mac}_climate")}, blocking=True
        )
    api.async_set_vacation_enabled.assert_not_awaited()
