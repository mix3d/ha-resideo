"""Hold end and next schedule period, from a T9 that held until the next period, then until 05:00.

Payloads come from tests/homes/t9-wifi-4-sensors.json: its REST shadow was read during the
05:00 hold, and its Setpoint pushes cover both holds and the NoHold between them.
"""

from __future__ import annotations

import copy
from typing import Any

from custom_components.resideo.aioresideo import ResideoThermostat, apply_live_feed
from custom_components.resideo.aioresideo.objects.events import ResideoLiveFeed
from tests.homes import captured_pushes, load_home

MAC = "AABBCCDDEEFF"
DEVICE = load_home("t9-wifi-4-sensors")["data"]["devices"][0]


def _setpoint_push(status: str, hold_until: str | None = None) -> dict[str, Any]:
    for name, value in captured_pushes(DEVICE):
        if name == "Setpoint" and value["Status"] == status and value.get("HoldUntilTime") == hold_until:
            return value
    raise AssertionError(f"no captured Setpoint push with {status} / {hold_until}")


def _merge(shadow: dict[str, Any], value: dict[str, Any]) -> dict[str, Any]:
    merged, _ = apply_live_feed(shadow, copy.deepcopy(DEVICE["rooms"]), ResideoLiveFeed(MAC, "Setpoint", value))
    return merged


def test_rest_shadow_during_a_hold_until() -> None:
    t = ResideoThermostat(copy.deepcopy(DEVICE["shadow"]))
    assert t.setpoint_status == "HoldUntil"
    assert t.hold_until == "05:00:00"
    assert t.next_period_time == "05:00:00"  # during a hold it is the hold's end


def test_no_hold_push_ends_the_hold_and_gives_the_next_period() -> None:
    shadow = _merge(copy.deepcopy(DEVICE["shadow"]), _setpoint_push("NoHold"))
    t = ResideoThermostat(shadow)
    assert t.setpoint_status == "NoHold"
    assert t.hold_until is None
    assert t.next_period_time == "17:00:00"


def test_hold_until_push_carries_its_end() -> None:
    shadow = _merge(copy.deepcopy(DEVICE["shadow"]), _setpoint_push("NoHold"))
    shadow = _merge(shadow, _setpoint_push("HoldUntil", "17:00:00"))
    t = ResideoThermostat(shadow)
    assert t.hold_until == "17:00:00"
    assert t.heat_setpoint == 64

    # Then a specific time picked on the touchscreen: same status, new end.
    t = ResideoThermostat(_merge(shadow, _setpoint_push("HoldUntil", "05:00:00")))
    assert t.hold_until == "05:00:00"
    assert t.next_period_time == "05:00:00"
