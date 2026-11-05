import copy
import importlib.util
import io
from pathlib import Path
import tempfile
import unittest
from urllib.error import HTTPError

spec = importlib.util.spec_from_file_location(
    "download", Path(__file__).parents[1] / "skills/scombz/scripts/download.py"
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

RECIPE = {
    "protocol": "scombz-direct-v1", "origin": module.ORIGIN,
    "session": "private-cookie", "file": {"filename": "fixture.pdf"},
    "headers": {"User-Agent": "Mozilla/5.0 (fixture)", "Accept": "*/*",
                "Accept-Language": "ja,en;q=0.8"},
    "prepare": module.ORIGIN + "/lms/course/make/tempfile?id=1",
    "download": module.ORIGIN + "/lms/course/material/setfiledown/fixture.pdf?fileId={temporary_file_id}",
}


class Response(io.BytesIO):
    status = 200
    headers = {"Content-Type": "application/octet-stream"}


class Opener:
    def __init__(self, responses):
        self.responses, self.requests = iter(responses), []

    def open(self, request, timeout):
        self.requests.append(request)
        assert request.get_header("Cookie") == "SESSION=private-cookie"
        assert request.get_header("User-agent") == RECIPE["headers"]["User-Agent"]
        response = next(self.responses)
        if isinstance(response, Exception):
            raise response
        return Response(response)


class DownloadTests(unittest.TestCase):
    def test_fresh_id_empty_retry_pdf_and_no_credentials_on_disk(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "fixture.pdf"
            opener = Opener([b"first", b"", b"new & id", b"%PDF-1.7 original"])
            result = module.download(copy.deepcopy(RECIPE), output, opener=opener)
            self.assertEqual(output.read_bytes(), b"%PDF-1.7 original")
            self.assertEqual(result["bytes"], 17)
            self.assertIn("fileId=new%20%26%20id", opener.requests[-1].full_url)
            self.assertEqual(list(Path(directory).iterdir()), [output])

    def test_assignment_skips_temporary_id(self):
        recipe = {**RECIPE, "prepare": None,
                  "download": module.ORIGIN + "/lms/course/report/submission_download/fixture.pdf"}
        with tempfile.TemporaryDirectory() as directory:
            opener = Opener([b"%PDF-fixture"])
            module.download(recipe, Path(directory) / "fixture.pdf", opener=opener)
            self.assertEqual(len(opener.requests), 1)

    def test_invalid_pdf_and_limit_leave_no_partial_file(self):
        for body, maximum in [(b"not a pdf", 100), (b"%PDF-large", 3)]:
            with self.subTest(body=body), tempfile.TemporaryDirectory() as directory:
                with self.assertRaises(module.DownloadError):
                    module.download(RECIPE, Path(directory) / "fixture.pdf", maximum,
                                    opener=Opener([b"id", body]))
                self.assertEqual(list(Path(directory).iterdir()), [])

    def test_foreign_url_and_write_path_never_receive_cookie(self):
        for url in ["https://evil.example/file", module.ORIGIN + "/lms/course/examination/take"]:
            with self.subTest(url=url), tempfile.TemporaryDirectory() as directory:
                opener = Opener([])
                with self.assertRaises(module.DownloadError):
                    module.download({**RECIPE, "prepare": None, "download": url},
                                    Path(directory) / "fixture.pdf", opener=opener)
                self.assertEqual(opener.requests, [])

    def test_429_stops_without_retry_and_preserves_retry_after(self):
        error = HTTPError(RECIPE["prepare"], 429, "limited", {"Retry-After": "60"}, io.BytesIO())
        with tempfile.TemporaryDirectory() as directory:
            opener = Opener([error])
            with self.assertRaises(module.DownloadError) as result:
                module.download(RECIPE, Path(directory) / "fixture.pdf", opener=opener)
            self.assertEqual(result.exception.details, {"status": 429, "retry_after": "60"})
            self.assertEqual(len(opener.requests), 1)

    def test_real_http_redirect_handler_refuses_automatic_redirects(self):
        self.assertIsNone(module.NoRedirect().redirect_request(None))


if __name__ == "__main__":
    unittest.main()
