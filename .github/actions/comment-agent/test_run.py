import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import run


class CommentAgentTest(unittest.TestCase):
    def test_merge_requires_an_explicit_command(self):
        self.assertEqual(run.merge_numbers("@codex merge #12, #13", "codex"), [12, 13])
        self.assertEqual(run.merge_numbers("@claude please merge this PR!", "claude", 12), [12])
        self.assertIsNone(run.merge_numbers("@codex fix the test, do not merge", "codex", 12))
        self.assertIsNone(run.merge_numbers("Quoted: @codex merge", "codex", 12))
        with self.assertRaises(ValueError):
            run.merge_numbers("@codex merge", "codex")

    def test_non_owner_cannot_authorize_a_run(self):
        event = {
            "action": "created", "sender": {"login": "stranger"},
            "comment": {"body": "@codex merge #12", "user": {"login": "stranger"}},
        }
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "event.json"
            path.write_text(json.dumps(event))
            with patch.dict(run.os.environ, {"GITHUB_EVENT_PATH": str(path), "GITHUB_REPOSITORY": run.REPO}):
                with self.assertRaises(ValueError):
                    run.get_event("codex")

    def test_claude_result_saves_the_final_message(self):
        messages = [{"type": "system", "subtype": "init"}, {"type": "result", "subtype": "success", "is_error": False, "result": " Fixed it. \n"}]
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / "claude-execution-output.json"
            log.write_text(json.dumps(messages))
            with patch.dict(run.os.environ, {"RUNNER_TEMP": directory, "EXECUTION_FILE": ""}):
                run.claude_result({}, "claude")
            self.assertEqual((Path(directory) / "agent-result" / "claude.txt").read_text(), "Fixed it.")

    def test_claude_result_reports_why_a_session_failed(self):
        messages = [{"type": "result", "subtype": "success", "is_error": True, "result": "Credit balance is too low\n::warning::x"}]
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / "log.json"
            log.write_text(json.dumps(messages))
            with (
                patch.dict(run.os.environ, {"RUNNER_TEMP": directory, "EXECUTION_FILE": str(log)}),
                patch("builtins.print") as printed,
            ):
                with self.assertRaisesRegex(ValueError, "did not finish successfully"):
                    run.claude_result({}, "claude")
            printed.assert_called_once_with("::error title=Claude Code failed::Credit balance is too low%0A::warning::x")
            self.assertFalse((Path(directory) / "agent-result").exists())

    def test_old_ci_cannot_authorize_merge(self):
        pull = {"number": 12, "head": {"sha": "head"}, "base": {"sha": "new"}}
        test_pr = {"number": 12, "base": {"ref": run.TRUNK, "sha": "old"}}
        check = {"app": {"slug": "github-actions"}, "conclusion": "success", "pull_requests": [test_pr]}
        runs = [{**check, "name": name} for name in run.REQUIRED_CHECKS]
        with patch.object(run, "api", side_effect=[{"total_count": len(runs), "check_runs": runs}, {"total_count": 0}]):
            missing, failing = run.ci_status(pull)
        self.assertEqual(missing, run.REQUIRED_CHECKS)
        self.assertFalse(failing)

    @staticmethod
    def open_pull(number):
        return {
            "number": number, "state": "open", "draft": False, "merged": False,
            "mergeable": True, "mergeable_state": "clean",
            "base": {"ref": run.TRUNK, "sha": f"base-{number}"},
            "head": {"sha": f"head-{number}", "ref": f"fix-{number}", "repo": {"full_name": run.REPO}},
        }

    @staticmethod
    def fake_api(behind=()):
        """Answer compare and merge calls; PRs whose head is in `behind` lag the trunk."""
        def answer(path, method="GET", data=None, *, public=False):
            if path.startswith("compare/"):
                return {"behind_by": 2 if path.rsplit("...", 1)[1] in behind else 0}
            if path.endswith("/update-branch"):
                return {"message": "Updating pull request branch."}
            if path.endswith("/merge"):
                return {"merged": True}
            raise AssertionError(f"Unexpected API call: {method} {path}")
        return answer

    def test_merge_stops_on_a_later_failure(self):
        event = {"issue": {"number": 12}, "comment": {"body": "@codex merge #12 #13 #14"}}
        with (
            patch.object(run, "mergeable_pull", side_effect=self.open_pull) as get_pull,
            patch.object(run, "ci_status", side_effect=[(set(), set()), (set(), {"CI Complete"})]),
            patch.object(run, "api", side_effect=self.fake_api()) as api,
            patch.object(run, "comment") as comment,
        ):
            with self.assertRaisesRegex(ValueError, "PR #13 needs green CI"):
                run.merge(event, "codex")
        api.assert_any_call("pulls/12/merge", "PUT", {"sha": "head-12", "merge_method": "merge"})
        self.assertEqual([call.args[0] for call in api.call_args_list if call.args[0].endswith("/merge")], ["pulls/12/merge"])
        self.assertEqual([call.args[0] for call in get_pull.call_args_list], [12, 12, 13])
        self.assertIn("Merged #12. Stopped", comment.call_args.args[1])

    def test_merge_checks_every_pr_against_the_latest_trunk(self):
        event = {"issue": {"number": 12}, "comment": {"body": "@codex merge #12"}}
        with (
            patch.object(run, "mergeable_pull", side_effect=self.open_pull),
            patch.object(run, "ci_status", return_value=(set(), set())),
            patch.object(run, "api", side_effect=self.fake_api()) as api,
            patch.object(run, "comment") as comment,
        ):
            run.merge(event, "codex")
        api.assert_any_call(f"compare/{run.TRUNK}...head-12", public=True)
        api.assert_any_call("pulls/12/merge", "PUT", {"sha": "head-12", "merge_method": "squash"})
        self.assertIn("Merged #12", comment.call_args.args[1])

    def test_merge_updates_a_green_pr_behind_the_trunk_instead_of_merging(self):
        event = {"issue": {"number": 12}, "comment": {"body": "@codex merge #12"}}
        with (
            patch.object(run, "mergeable_pull", side_effect=self.open_pull),
            patch.object(run, "ci_status", return_value=(set(), set())),
            patch.object(run, "api", side_effect=self.fake_api(behind={"head-12"})) as api,
            patch.object(run, "comment") as comment,
        ):
            with self.assertRaisesRegex(ValueError, "PR #12 was behind .* not merged"):
                run.merge(event, "codex")
        api.assert_any_call("pulls/12/update-branch", "PUT", {"expected_head_sha": "head-12"})
        self.assertFalse([call for call in api.call_args_list if call.args[0].endswith("/merge")])
        self.assertIn("issue the merge command again", comment.call_args.args[1])

    def test_merge_keeps_earlier_prs_merged_when_a_later_one_is_behind(self):
        event = {"issue": {"number": 12}, "comment": {"body": "@codex merge #12 #13"}}
        with (
            patch.object(run, "mergeable_pull", side_effect=self.open_pull),
            patch.object(run, "ci_status", return_value=(set(), set())),
            patch.object(run, "api", side_effect=self.fake_api(behind={"head-13"})) as api,
            patch.object(run, "comment") as comment,
        ):
            with self.assertRaisesRegex(ValueError, "PR #13 was behind"):
                run.merge(event, "codex")
        merges = [call.args[0] for call in api.call_args_list if call.args[0].endswith("/merge")]
        self.assertEqual(merges, ["pulls/12/merge"])
        api.assert_any_call("pulls/13/update-branch", "PUT", {"expected_head_sha": "head-13"})
        self.assertIn("Merged #12. Stopped: PR #13 was behind", comment.call_args.args[1])
