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

    def test_old_ci_cannot_authorize_merge(self):
        pull = {"number": 12, "head": {"sha": "head"}, "base": {"sha": "new"}}
        test_pr = {"number": 12, "base": {"ref": run.TRUNK, "sha": "old"}}
        check = {"app": {"slug": "github-actions"}, "conclusion": "success", "pull_requests": [test_pr]}
        runs = [{**check, "name": name} for name in run.REQUIRED_CHECKS]
        with patch.object(run, "api", side_effect=[{"total_count": len(runs), "check_runs": runs}, {"total_count": 0}]):
            missing, failing = run.ci_status(pull)
        self.assertEqual(missing, run.REQUIRED_CHECKS)
        self.assertFalse(failing)

    def test_merge_stops_on_a_later_failure(self):
        def pull(number):
            return {
                "number": number, "state": "open", "draft": False, "merged": False,
                "mergeable": True, "mergeable_state": "clean",
                "base": {"ref": run.TRUNK, "sha": f"base-{number}"},
                "head": {"sha": f"head-{number}", "ref": f"fix-{number}", "repo": {"full_name": run.REPO}},
            }

        event = {"issue": {"number": 12}, "comment": {"body": "@codex merge #12 #13 #14"}}
        with (
            patch.object(run, "mergeable_pull", side_effect=pull) as get_pull,
            patch.object(run, "ci_status", side_effect=[(set(), set()), (set(), {"CI Complete"})]),
            patch.object(run, "api", return_value={"merged": True}) as api,
            patch.object(run, "comment") as comment,
        ):
            with self.assertRaisesRegex(ValueError, "PR #13 needs green CI"):
                run.merge(event, "codex")
        api.assert_called_once_with("pulls/12/merge", "PUT", {"sha": "head-12", "merge_method": "merge"})
        self.assertEqual([call.args[0] for call in get_pull.call_args_list], [12, 12, 13])
        self.assertIn("Merged #12. Stopped", comment.call_args.args[1])
