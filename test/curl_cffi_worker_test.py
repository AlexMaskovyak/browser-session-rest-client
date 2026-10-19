import importlib.util
import base64
import io
import json
from pathlib import Path
import types
import unittest
from unittest.mock import Mock, patch


spec = importlib.util.spec_from_file_location(
    "curl_worker", Path(__file__).resolve().parents[1] / "src" / "curl-cffi-worker.py"
)
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class WorkerPostTests(unittest.TestCase):
    def run_worker(self, configuration, request):
        response = types.SimpleNamespace(
            status_code=200,
            headers=types.SimpleNamespace(multi_items=lambda: []),
            url="https://example.test/query",
            content=b"ok",
        )
        request.return_value = response
        output = io.StringIO()
        with (
            patch.dict("sys.modules", {"curl_cffi": types.SimpleNamespace(requests=types.SimpleNamespace(request=request))}),
            patch("sys.stdin", io.StringIO(json.dumps(configuration))),
            patch("sys.stdout", output),
        ):
            worker.main()
        return json.loads(output.getvalue())

    def configuration(self, **changes):
        return {"url": "https://example.test/query", "method": "POST", "headers": {}, "timeout": 5, **changes}

    def test_post_requires_explicit_boolean_authorization(self):
        for flag in (None, False, 1, "true"):
            request = Mock()
            with self.assertRaises(ValueError):
                self.run_worker(self.configuration(authorizedPost=flag, body="{}"), request)
            request.assert_not_called()

    def test_authorized_post_preserves_utf8_body_and_disables_redirects(self):
        request = Mock()
        body = '{"query":"synthetic_read","label":"é"}'
        result = self.run_worker(self.configuration(authorizedPost=True, body=body), request)
        self.assertEqual(result["status"], 200)
        self.assertEqual(request.call_args.args, ("POST", "https://example.test/query"))
        self.assertEqual(request.call_args.kwargs["data"], body.encode("utf-8"))
        self.assertIs(request.call_args.kwargs["allow_redirects"], False)

    def test_rejects_invalid_or_large_post_body_before_request(self):
        for body in (None, {}, "é" * (1024 * 1024)):
            request = Mock()
            with self.assertRaises(ValueError):
                self.run_worker(self.configuration(authorizedPost=True, body=body), request)
            request.assert_not_called()

    def test_authorized_binary_write_preserves_bytes(self):
        request = Mock()
        body = b"\x00\xff\x80receipt"
        self.run_worker(self.configuration(method="PUT", authorizedWrite=True, bodyBase64=base64.b64encode(body).decode()), request)
        self.assertEqual(request.call_args.kwargs["data"], body)
        self.assertIs(request.call_args.kwargs["allow_redirects"], False)

    def test_binary_writes_reject_missing_authorization_and_invalid_base64(self):
        for changes in ({"bodyBase64": "AA=="}, {"authorizedWrite": True, "bodyBase64": "!invalid"}):
            request = Mock()
            with self.assertRaises(ValueError):
                self.run_worker(self.configuration(method="PUT", **changes), request)
            request.assert_not_called()


if __name__ == "__main__":
    unittest.main()
