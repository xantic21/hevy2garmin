"""Network-free tests for the portfolio GitHub-only monitoring control plane."""

import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import ops

NOW = datetime(2026, 12, 20, tzinfo=timezone.utc)


def run(conclusion="success", age=0, event="schedule"):
    date = (NOW - timedelta(days=age)).isoformat()
    return {
        "status": "completed",
        "conclusion": conclusion,
        "event": event,
        "created_at": date,
        "updated_at": date,
    }


class SafetyTests(unittest.TestCase):
    def test_two_failures_are_a_blocker(self):
        self.assertTrue(ops.failing_twice([run("failure"), run("timed_out", 1)], NOW))

    def test_one_failure_does_not_page(self):
        self.assertFalse(ops.failing_twice([run("failure"), run("success", 1)], NOW))
        self.assertFalse(ops.failing_twice([run("failure")], NOW))

    def test_cancelled_is_not_sustained_failure(self):
        self.assertFalse(ops.failing_twice([run("cancelled"), run("failure", 1)], NOW))

    def test_stale_results_do_not_page(self):
        self.assertFalse(ops.failing_twice([run("failure", 20), run("failure", 21)], NOW))

    def test_two_successes_confirm_recovery(self):
        self.assertTrue(ops.success_twice([run(), run(age=1)]))
        self.assertFalse(ops.success_twice([run("failure"), run()]))

    def test_disabled_schedule_detected(self):
        self.assertEqual(
            ops.schedule_problem("disabled_manually", [], 7, NOW), "inactive or disabled workflow"
        )

    def test_not_early_alert_before_first_schedule(self):
        before = datetime(2026, 11, 27, tzinfo=timezone.utc)
        self.assertIsNone(ops.schedule_problem("active", [], 7, before))
        self.assertEqual(
            ops.schedule_problem("active", [], 7, NOW), "no scheduled execution observed"
        )

    def test_schedule_delay_and_transient_failure(self):
        self.assertEqual(
            ops.schedule_problem("active", [run(age=11)], 7, NOW), "scheduled execution overdue"
        )
        self.assertIsNone(ops.schedule_problem("active", [run("failure")], 7, NOW))
        self.assertEqual(
            ops.schedule_problem("active", [run("failure"), run("failure", 1)], 7, NOW),
            "two consecutive scheduled failures",
        )

    def test_ambiguous_does_not_close_issue(self):
        response = {"has_issues": True}
        current = [{"number": 15, "state": "open", "body": "<!-- portfolio-ops:qa:quality.yml -->"}]
        with patch.object(ops, "api", side_effect=[response, current]) as mocked:
            self.assertEqual(
                ops.issue_sync("xantic21/coffee-lab", {"qa:quality.yml": None}, NOW), []
            )
            self.assertEqual(mocked.call_count, 2)

    def test_confirmed_recovery_closes_existing_issue(self):
        response = {"has_issues": True}
        current = [{"number": 15, "state": "open", "body": "<!-- portfolio-ops:qa:quality.yml -->"}]
        with patch.object(
            ops, "api", side_effect=[response, current, {"state": "closed"}]
        ) as mocked:
            changes = ops.issue_sync("xantic21/coffee-lab", {"qa:quality.yml": False}, NOW)
            self.assertEqual(len(changes), 1)
            self.assertEqual(mocked.call_args.args[2], "PATCH")

    def test_api_failures_are_unknown_and_never_open_issues(self):
        policy = {"qa": ["ci.yml"], "schedules": {"safe-branch-cleanup.yml": 7}}
        for error in (
            ops.urllib.error.URLError("offline"),
            TimeoutError(),
            ValueError("bad json"),
            RuntimeError("Missing job-scoped GITHUB_TOKEN"),
            KeyError("workflow_runs"),
        ):
            with self.subTest(error=type(error).__name__):
                with patch.object(ops, "api", side_effect=error):
                    found, rows = ops.checks("xantic21/hevy2garmin", policy, NOW)
                self.assertEqual(found, {})
                self.assertEqual(len(rows), 2)
                self.assertTrue(all("unknown; API error" in value for _, value in rows))

    def test_unexpected_defects_are_not_swallowed(self):
        policy = {"qa": ["ci.yml"], "schedules": {}}
        with (
            patch.object(ops, "api", side_effect=ZeroDivisionError()),
            self.assertRaises(ZeroDivisionError),
        ):
            ops.checks("xantic21/hevy2garmin", policy, NOW)

    def test_newest_marked_issue_is_selected(self):
        marker = "<!-- portfolio-ops:qa:ci.yml -->"
        current = [
            {"number": 4, "state": "open", "body": marker},
            {"number": 9, "state": "closed", "body": marker},
        ]
        with patch.object(
            ops, "api", side_effect=[{"has_issues": True}, current, {"state": "open"}]
        ) as mocked:
            changes = ops.issue_sync("xantic21/hevy2garmin", {"qa:ci.yml": True}, NOW)
        self.assertEqual(changes, ["Reopened #9 for qa:ci.yml"])
        self.assertEqual(mocked.call_args.args[1], "issues/9")

    def test_explicit_allowlist_contains_all_seven(self):
        self.assertEqual(len(ops.POLICY), 7)
        self.assertEqual(len(ops.POLICY["xantic21"]["qa"]), 0)


if __name__ == "__main__":
    unittest.main()
