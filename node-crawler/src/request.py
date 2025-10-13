#!/usr/bin/env python3
"""
simple_request.py

Send a single JSON POST request and print/save the response.

Usage examples:
  python simple_request.py --url http://localhost:5001/crawl --input scan-request.json
  python simple_request.py --url http://localhost:5001/crawl --data '{"url":"http://testphp.vulnweb.com"}'
  python simple_request.py --url http://localhost:5001/crawl --input scan-request.json --out resp.json --proxy http://127.0.0.1:8080 --token MYTOKEN

Notes:
 - Requires `requests` (pip install requests).
 - Use only against targets you control or are authorized to test.
"""

import argparse
import json
import requests
from pathlib import Path
import sys

def load_json_from_file(p: Path):
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"Failed to read/parse JSON from {p}: {e}", file=sys.stderr)
        raise

def main():
    ap = argparse.ArgumentParser(description="Send a single JSON POST and print/save the response.")
    ap.add_argument("--url", "-u", required=True, help="Target URL (e.g. http://localhost:5001/crawl)")
    group = ap.add_mutually_exclusive_group(required=True)
    group.add_argument("--input", "-i", help="Path to JSON file to send as body")
    group.add_argument("--data", "-d", help="Inline JSON string to send as body")
    ap.add_argument("--out", "-o", help="Optional output file to save response JSON")
    ap.add_argument("--timeout", type=int, default=60, help="Request timeout in seconds (default 60)")
    ap.add_argument("--proxy", help="Optional HTTP proxy (e.g. http://127.0.0.1:8080)")
    ap.add_argument("--token", help="Optional Bearer token for Authorization header")
    ap.add_argument("--pretty", action="store_true", help="Pretty-print JSON response")
    args = ap.parse_args()

    # Prepare body
    if args.input:
        body = load_json_from_file(Path(args.input))
    else:
        try:
            body = json.loads(args.data)
        except Exception as e:
            print(f"Invalid inline JSON (--data): {e}", file=sys.stderr)
            sys.exit(2)

    headers = {"Content-Type": "application/json"}
    if args.token:
        headers["Authorization"] = f"Bearer {args.token}"

    proxies = {"http": args.proxy, "https": args.proxy} if args.proxy else None

    try:
        resp = requests.post(args.url, json=body, headers=headers, timeout=args.timeout, proxies=proxies)
    except requests.RequestException as e:
        print(f"Request failed: {e}", file=sys.stderr)
        sys.exit(3)

    # Try to parse JSON response, else print text
    content_type = resp.headers.get("Content-Type", "")
    out_obj = None
    if "application/json" in content_type or resp.text.strip().startswith(("{", "[")):
        try:
            out_obj = resp.json()
        except Exception:
            out_obj = resp.text

    if args.out:
        try:
            # if parsed JSON, write JSON; else write raw text
            if isinstance(out_obj, (dict, list)):
                Path(args.out).write_text(json.dumps(out_obj, indent=2, ensure_ascii=False), encoding="utf-8")
            else:
                Path(args.out).write_text(str(out_obj), encoding="utf-8")
            print(f"Response saved to {args.out}")
        except Exception as e:
            print(f"Failed to write output file {args.out}: {e}", file=sys.stderr)

    # Print results
    print(f"HTTP {resp.status_code} {resp.reason}")
    if args.pretty and isinstance(out_obj, (dict, list)):
        print(json.dumps(out_obj, indent=2, ensure_ascii=False))
    else:
        print(out_obj if out_obj is not None else resp.text)

if __name__ == "__main__":
    main()     