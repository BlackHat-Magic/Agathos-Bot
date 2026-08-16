import json
import unittest
from pathlib import Path


ROOT = Path(__file__).parents[1]


class CloudflareConfigTests(unittest.TestCase):
	def test_evaluator_is_not_published_to_workers_dev(self):
		config = json.loads((ROOT / "workers/evaluator/wrangler.jsonc").read_text())

		self.assertIs(config["workers_dev"], False)
		self.assertEqual(config["base_dir"], "src")

	def test_interaction_worker_declares_replay_sqlite_binding(self):
		config = json.loads((ROOT / "workers/interactions/wrangler.jsonc").read_text())

		self.assertEqual(
			config["durable_objects"]["bindings"],
			[{"name": "REPLAY_GUARD", "class_name": "ReplayGuard"}],
		)
		self.assertEqual(
			config["migrations"],
			[
				{
					"tag": "v1",
					"new_sqlite_classes": ["ReplayGuard"],
				}
			],
		)
		self.assertEqual(config["services"][0]["service"], "agathos-evaluator")

	def test_evaluator_bundle_ignore_file_keeps_runtime_sources(self):
		ignore_lines = (
			(ROOT / "workers/evaluator/.wranglerignore").read_text().splitlines()
		)

		self.assertIn("workers/", ignore_lines)
		self.assertIn("tests/", ignore_lines)
		self.assertIn("docs/", ignore_lines)
		self.assertIn("src/", ignore_lines)
		self.assertIn(".venv*", ignore_lines)
		self.assertIn("node_modules/", ignore_lines)
		self.assertNotIn("entry.py", ignore_lines)
		self.assertNotIn("python_modules/", ignore_lines)
		self.assertIn("pyproject.toml", ignore_lines)
		self.assertIn("uv.lock", ignore_lines)


if __name__ == "__main__":
	unittest.main()
