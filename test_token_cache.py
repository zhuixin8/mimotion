import base64
import json
import tempfile
import unittest
from pathlib import Path

from util.aes_help import encrypt_data
from util.token_cache import restore_tokens


class TokenCacheTests(unittest.TestCase):
    def setUp(self):
        self.key = b"abcdefghijklmnop"
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = str(Path(self.temp.name) / "tokens")

    def encoded(self, values, key=None):
        return encrypt_data(json.dumps(values).encode(), key or self.key)

    def test_newer_refreshed_cache_wins_over_bootstrap(self):
        Path(self.path).write_bytes(self.encoded({"user": {"app_token_time": "200", "app_token": "new"}}))
        bootstrap = base64.b64encode(self.encoded({"user": {"app_token_time": "100", "app_token": "old"}})).decode()
        self.assertEqual(restore_tokens(self.key, bootstrap, self.path)["user"]["app_token"], "new")

    def test_rekeyed_web_login_recovers_old_cache(self):
        Path(self.path).write_bytes(self.encoded({"old": {}}, b"zyxwvutsrqponmlk"))
        bootstrap = base64.b64encode(self.encoded({"new": {"app_token_time": "300"}})).decode()
        self.assertEqual(list(restore_tokens(self.key, bootstrap, self.path)), ["new"])

    def test_corrupt_bootstrap_does_not_destroy_valid_cache(self):
        Path(self.path).write_bytes(self.encoded({"user": {"app_token_time": "200"}}))
        self.assertIn("user", restore_tokens(self.key, "%%%", self.path))

    def test_missing_cache_is_empty(self):
        self.assertEqual(restore_tokens(self.key, "", self.path), {})


if __name__ == "__main__":
    unittest.main()
