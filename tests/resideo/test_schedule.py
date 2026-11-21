"""The whole-schedule read and write (First Alert app 3.0.5, decompiled; no capture yet).

No home holds a schedule yet, so these treat it as an opaque object: the integration passes
what the cloud returned back unchanged, or what the caller gives it.
"""

from __future__ import annotations

import pytest
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ServiceValidationError
from pytest_homeassistant.common import MockConfigEntry

from tests.homes import load_home

from .conftest import eid, home_api, setup_integration

SCHEDULE = {"ScheduleType": "Timed"}


async def _setup(hass: HomeAssistant, entry: MockConfigEntry, schedule: dict):
    home = load_home("t9-wifi-4-sensors")
    home["data"]["devices"][0]["schedule"] = schedule
    api = home_api(home)
    await setup_integration(hass, entry, api)
    mac = api.macs[0]
    return api, mac, eid(hass, "climate", f"{mac}_climate")


async def test_get_schedule_reads_it_fresh(hass: HomeAssistant, mock_config_entry: MockConfigEntry) -> None:
    _, _, climate_id = await _setup(hass, mock_config_entry, SCHEDULE)

    response = await hass.services.async_call(
        "resideo", "get_schedule", {"entity_id": climate_id}, blocking=True, return_response=True
    )
    assert response == {climate_id: SCHEDULE}


async def test_set_schedule_without_one_sends_back_the_last_read(
    hass: HomeAssistant, mock_config_entry: MockConfigEntry
) -> None:
    api, mac, climate_id = await _setup(hass, mock_config_entry, SCHEDULE)

    await hass.services.async_call("resideo", "set_schedule", {"entity_id": climate_id}, blocking=True)
    api.async_set_schedule.assert_awaited_once_with(mac, SCHEDULE)


async def test_set_schedule_sends_the_one_given(hass: HomeAssistant, mock_config_entry: MockConfigEntry) -> None:
    api, mac, climate_id = await _setup(hass, mock_config_entry, SCHEDULE)
    edited = {"ScheduleType": "None"}

    await hass.services.async_call(
        "resideo", "set_schedule", {"entity_id": climate_id, "schedule": edited}, blocking=True
    )
    api.async_set_schedule.assert_awaited_once_with(mac, edited)


async def test_set_schedule_with_nothing_read_is_refused(
    hass: HomeAssistant, mock_config_entry: MockConfigEntry
) -> None:
    api, _, climate_id = await _setup(hass, mock_config_entry, {})

    with pytest.raises(ServiceValidationError):
        await hass.services.async_call("resideo", "set_schedule", {"entity_id": climate_id}, blocking=True)
    api.async_set_schedule.assert_not_awaited()
