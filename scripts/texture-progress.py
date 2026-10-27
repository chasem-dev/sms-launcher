#!/usr/bin/env python3
"""Run the port's texture installer with download progress on piped stdout.

The port still owns the URL, checksum, disk checks and installation. This
adapter counts bytes as its existing downloader reads the HTTP response, and
resumes the download when the connection drops (resume_downloads.py).
"""

import sys
import time
import urllib.request

import resume_downloads


class ProgressResponse:
    def __init__(self, response):
        self.response = response
        try:
            self.total = max(0, int(response.headers.get("Content-Length") or 0))
        except (TypeError, ValueError):
            self.total = 0
        self.received = 0
        self.reported_at = 0.0

    def report(self):
        # A part of a file (an HTTP range request, as the Eclipse textures' installer
        # makes) is not a download of its own: that installer reports its progress.
        if getattr(self.response, "status", 200) == 206:
            return
        print("Texture download: %d/%d bytes" % (self.received, self.total), flush=True)
        self.reported_at = time.monotonic()

    def read(self, *args, **kwargs):
        chunk = self.response.read(*args, **kwargs)
        self.received += len(chunk)
        if not chunk or time.monotonic() - self.reported_at >= 0.5:
            self.report()
        if not chunk and getattr(self.response, "status", 200) != 206:
            print("Checking HD texture download", flush=True)
        return chunk

    def __enter__(self):
        self.response.__enter__()
        self.report()
        return self

    def __exit__(self, *args):
        return self.response.__exit__(*args)

    def __getattr__(self, name):
        return getattr(self.response, name)


def main():
    # texture-progress.py GET_PY [get.py's arguments, "textures" by default]
    installer = sys.argv[1]
    original_urlopen = urllib.request.urlopen
    resuming = resume_downloads.resuming(original_urlopen)
    try:
        urllib.request.urlopen = lambda *args, **kwargs: ProgressResponse(resuming(*args, **kwargs))
        resume_downloads.run(installer, sys.argv[2:] or ["textures"])
    finally:
        urllib.request.urlopen = original_urlopen


if __name__ == "__main__":
    main()
