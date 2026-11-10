#!/usr/bin/env python3
"""Serve the repo for harness.html, plus --work at /work/ (videos stay out of git).
PUT /work/<name> saves the GPU captures that compare.py --gpu-check reads.
usage: serve.py --work <dir> [--port 8799]"""
import argparse, http.server, os

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "../../../.."))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--work", required=True)
    ap.add_argument("--port", type=int, default=8799)
    a = ap.parse_args()
    work = os.path.abspath(a.work)

    class Handler(http.server.SimpleHTTPRequestHandler):
        def translate_path(self, path):
            if path.startswith("/work/"):
                return os.path.join(work, os.path.basename(path.split("?")[0]))
            return super().translate_path(path)

        def do_PUT(self):
            if not self.path.startswith("/work/"):
                return self.send_error(403)
            with open(self.translate_path(self.path), "wb") as fh:
                fh.write(self.rfile.read(int(self.headers["Content-Length"])))
            self.send_response(204)
            self.end_headers()

    os.chdir(REPO)
    http.server.ThreadingHTTPServer(("127.0.0.1", a.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
