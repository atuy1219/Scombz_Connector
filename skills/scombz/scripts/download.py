"""Download a prepare_file_download recipe from stdin. Never persist credentials."""
import argparse
import json
import os
from pathlib import Path
import sys
import tempfile
from urllib.error import HTTPError
from urllib.parse import quote, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

ORIGIN = "https://scombz.shibaura-it.ac.jp"


class DownloadError(Exception):
    def __init__(self, code, **details):
        self.code, self.details = code, details


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


def download(recipe, output, maximum=100 * 1024 * 1024, opener=None):
    if recipe.get("protocol") != "scombz-direct-v1" or recipe.get("origin") != ORIGIN:
        raise DownloadError("invalid_recipe")
    session = recipe.get("session", "")
    if not isinstance(session, str) or not session or any(
        ord(c) < 33 or ord(c) > 126 or c in ";," for c in session
    ):
        raise DownloadError("invalid_session")
    # Only the shared basic headers are accepted; never forward arbitrary recipe headers.
    source_headers = recipe.get("headers", {})
    headers = {k: source_headers[k] for k in ("User-Agent", "Accept", "Accept-Language")}
    if not headers["User-Agent"].startswith("Mozilla/5.0 ("):
        raise DownloadError("invalid_user_agent")
    headers["Cookie"] = "SESSION=" + session
    opener = opener or build_opener(NoRedirect)
    output = Path(output)
    if output.exists():
        raise DownloadError("output_exists")  # Caller should reuse a known original, not overwrite it.
    pdf = recipe["file"]["filename"].lower().endswith(".pdf")

    def get(url, prepare=False):
        parsed = urlsplit(url)
        valid_path = (
            parsed.path == "/lms/course/make/tempfile" if prepare else
            parsed.path.startswith(("/lms/course/material/setfiledown/",
                                    "/lms/course/report/submission_download/"))
        )
        if (parsed.scheme != "https" or parsed.netloc != "scombz.shibaura-it.ac.jp"
                or parsed.fragment or not valid_path):
            raise DownloadError("forbidden_url")
        try:
            response = opener.open(Request(url, headers=headers, method="GET"), timeout=60)
        except HTTPError as error:
            status = error.code
            error.close()
            # No status-based automatic session refresh or burst retry.
            raise DownloadError("http_error", status=status,
                                retry_after=error.headers.get("Retry-After")) from None
        if response.status != 200:
            response.close()
            raise DownloadError("http_error", status=response.status)
        return response

    for attempt in range(2):
        url = recipe["download"]
        if recipe.get("prepare"):
            with get(recipe["prepare"], prepare=True) as response:
                temporary = response.read(8193).decode("utf-8")
            if (not temporary.strip() or len(temporary) > 2048
                    or any(c in temporary for c in "<>\r\n")):
                raise DownloadError("invalid_temporary_id")
            if url.count("{temporary_file_id}") != 1:
                raise DownloadError("invalid_recipe")
            url = url.replace("{temporary_file_id}", quote(temporary.strip(), safe=""))
        temporary_path = None
        try:
            with get(url) as response:
                if "text/html" in response.headers.get("Content-Type", "").lower():
                    raise DownloadError("unexpected_html")
                with tempfile.NamedTemporaryFile(dir=output.parent, delete=False) as target:
                    temporary_path = target.name
                    size, signature = 0, b""
                    while chunk := response.read(64 * 1024):
                        size += len(chunk)
                        if size > maximum:
                            raise DownloadError("file_too_large")
                        signature = (signature + chunk)[:5]
                        target.write(chunk)
            if not size:
                if attempt == 0 and recipe.get("prepare"):
                    continue
                raise DownloadError("empty_body")
            if pdf and signature != b"%PDF-":
                raise DownloadError("invalid_pdf")
            # Publish atomically without replacing an existing user file.
            os.link(temporary_path, output)
            return {"path": str(output.resolve()), "bytes": size, "format": "pdf" if pdf else "binary"}
        finally:
            if temporary_path is not None:
                os.unlink(temporary_path)
    raise DownloadError("empty_body")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output")
    parser.add_argument("--max-bytes", type=int, default=100 * 1024 * 1024)
    args = parser.parse_args()
    try:
        if args.max_bytes < 1:
            raise DownloadError("invalid_limit")
        result = download(json.load(sys.stdin), args.output, args.max_bytes)
    except DownloadError as error:
        print(json.dumps({"error": error.code, **error.details}), file=sys.stderr)
        return 1
    except Exception:
        # Do not echo exception messages, URLs, recipes or headers containing credentials.
        print(json.dumps({"error": "download_failed"}), file=sys.stderr)
        return 1
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
