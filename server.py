# -*- coding: utf-8 -*-
"""Sirve el visor como archivos estáticos."""
import sys
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler


if __name__ == "__main__":
  port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
  print("http://127.0.0.1:%s/" % port, flush=True)
  ThreadingHTTPServer(("127.0.0.1", port), SimpleHTTPRequestHandler).serve_forever()
