import contextlib
import io
import unittest
from unittest.mock import patch

import server


class AlertCadenceTests(unittest.TestCase):
    def setUp(self):
        self.cfg = server.Config(center_lat=36.0, center_lon=-85.0)

    def test_alert_filter(self):
        cases = [
            ([], False),
            (["Dense Fog Advisory"], False),
            (["Freezing Fog Advisory"], False),
            (["Dense Fog Advisory", "Freezing Fog Advisory"], False),
            (["Tornado Warning"], True),
            (["Dense Fog Advisory", "Tornado Warning"], True),
            (["Severe Thunderstorm Warning", "Freezing Fog Advisory"], True),
            (["Unknown Alert"], True),
        ]
        for events, expected in cases:
            with self.subTest(events=events):
                data = {
                    "features": [{"properties": {"event": event}} for event in events]
                }
                with patch.object(server, "http_get_json", return_value=data) as fetch:
                    self.assertEqual(server.fetch_alert_active(self.cfg), expected)
                    fetch.assert_called_once_with(
                        "https://api.weather.gov/alerts/active?point=36.0000,-85.0000"
                    )

    def test_empty_response(self):
        for data in ({}, {"features": None}):
            with self.subTest(data=data):
                with patch.object(server, "http_get_json", return_value=data):
                    self.assertFalse(server.fetch_alert_active(self.cfg))

    def test_missing_event_is_not_ignored(self):
        for feature in ({}, {"properties": {}}, {"properties": None}):
            with self.subTest(feature=feature):
                with patch.object(
                    server, "http_get_json", return_value={"features": [feature]}
                ):
                    self.assertTrue(server.fetch_alert_active(self.cfg))

    def test_request_failure_propagates(self):
        with patch.object(server, "http_get_json", side_effect=OSError("NWS unavailable")):
            with self.assertRaises(OSError):
                server.fetch_alert_active(self.cfg)

    def test_request_failure_preserves_radar_fallback(self):
        for dbz, expected in ((39, False), (40, True), (55, True)):
            with self.subTest(dbz=dbz):
                grid = [[None] * server.GRID_SIZE for _ in range(server.GRID_SIZE)]
                grid[0][0] = dbz
                with patch.object(server, "fetch_radar_reflectivity_grid", return_value=grid):
                    with patch.object(
                        server, "http_get_json", side_effect=OSError("NWS unavailable")
                    ):
                        with contextlib.redirect_stderr(io.StringIO()):
                            frames, active = server.build_frames_for_cycle(self.cfg)
                self.assertEqual(active, expected)
                self.assertEqual(len(frames), 1)


if __name__ == "__main__":
    unittest.main()
