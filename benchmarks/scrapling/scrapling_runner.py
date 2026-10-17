#!/usr/bin/env python3
"""Parser-only Scrapling adapter for the frozen offline fixture benchmark."""
import json
import os
import sys
import time
from pathlib import Path

from scrapling import Selector
from scrapling.engines.toolbelt.custom import Response

def main():
    request = json.loads(sys.stdin.read())
    html = Path(request["html_path"]).read_text(encoding="utf-8")
    start = time.perf_counter_ns()
    if request["mode"] == "generic":
        response = Response(url=request["url"], content=html, status=200, reason="fixture", cookies={}, headers={}, request_headers={})
        output = response.markdown(main_content_only=True)
        selected = bool(output.strip())
    else:
        storage_file = request["storage_file"]
        os.makedirs(os.path.dirname(storage_file), exist_ok=True)
        selector = Selector(content=html, url=request["url"], adaptive=True, storage_args={"storage_file": storage_file, "url": request["url"]})
        matches = selector.css(request["selector"], identifier=request["identifier"], adaptive=request["adaptive"], auto_save=request["auto_save"], percentage=70)
        output = matches[0].html_content if matches else ""
        selected = bool(matches)
    print(json.dumps({"output": output, "selected": selected, "parse_ns": time.perf_counter_ns() - start}))

if __name__ == "__main__":
    main()
