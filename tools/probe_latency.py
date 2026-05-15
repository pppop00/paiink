#!/usr/bin/env python3
"""probe_latency.py — measure pai.ink reachability from wherever you run it.

Usage:
    python probe_latency.py https://pai.ink --runs 20

Per run, measures:
    dns_ms          — DNS resolution
    connect_ms      — TCP + TLS handshake
    ttfb_ms         — time to first byte after request sent
    total_ms        — full response body
    bytes           — body size
    status          — HTTP status code
    ok              — bool (status < 400 and no exception)

Probes three paths in sequence: `/`, `/finance/`, and a random article
page if one can be found. Writes a CSV next to itself.

No third-party deps. urllib only.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import socket
import ssl
import statistics
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


def probe(url: str, timeout: float = 15.0) -> dict:
    """One measurement. Returns a dict with all timing fields populated."""
    parsed = urllib.parse.urlparse(url)
    host = parsed.hostname or ""
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    path = parsed.path or "/"
    if parsed.query:
        path += "?" + parsed.query

    out = {
        "url": url,
        "dns_ms": None, "connect_ms": None, "ttfb_ms": None, "total_ms": None,
        "bytes": 0, "status": None, "ok": False, "error": "",
    }

    try:
        t0 = time.perf_counter()
        addrs = socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP)
        out["dns_ms"] = (time.perf_counter() - t0) * 1000
        family, type_, proto, _, sockaddr = addrs[0]
    except OSError as e:
        out["error"] = f"dns: {e}"
        return out

    sock = socket.socket(family, type_, proto)
    sock.settimeout(timeout)
    try:
        t1 = time.perf_counter()
        sock.connect(sockaddr)
        if parsed.scheme == "https":
            ctx = ssl.create_default_context()
            sock = ctx.wrap_socket(sock, server_hostname=host)
        out["connect_ms"] = (time.perf_counter() - t1) * 1000

        req = (
            f"GET {path} HTTP/1.1\r\n"
            f"Host: {host}\r\n"
            f"User-Agent: pai-latency-probe/1.0\r\n"
            f"Accept: */*\r\n"
            f"Connection: close\r\n\r\n"
        ).encode()

        t2 = time.perf_counter()
        sock.sendall(req)

        buf = b""
        first = True
        while True:
            chunk = sock.recv(65536)
            if first and chunk:
                out["ttfb_ms"] = (time.perf_counter() - t2) * 1000
                first = False
            if not chunk:
                break
            buf += chunk

        out["total_ms"] = (time.perf_counter() - t2) * 1000
        out["bytes"] = len(buf)
        header_end = buf.find(b"\r\n\r\n")
        status_line = buf.split(b"\r\n", 1)[0].decode("ascii", "replace")
        parts = status_line.split(" ", 2)
        if len(parts) >= 2 and parts[1].isdigit():
            out["status"] = int(parts[1])
            out["ok"] = out["status"] < 400
    except (OSError, ssl.SSLError) as e:
        out["error"] = f"transport: {e}"
    finally:
        try:
            sock.close()
        except Exception:
            pass
    return out


def summarize(rows: list[dict], label: str) -> str:
    oks = [r for r in rows if r["ok"]]
    if not oks:
        return f"{label}: 0/{len(rows)} ok"
    ttfb = sorted(r["ttfb_ms"] for r in oks if r["ttfb_ms"] is not None)
    total = sorted(r["total_ms"] for r in oks if r["total_ms"] is not None)

    def pct(xs, p):
        if not xs:
            return float("nan")
        i = min(len(xs) - 1, int(round((p / 100) * (len(xs) - 1))))
        return xs[i]

    return (
        f"{label}: {len(oks)}/{len(rows)} ok | "
        f"ttfb median={statistics.median(ttfb):.0f}ms p95={pct(ttfb, 95):.0f}ms | "
        f"total median={statistics.median(total):.0f}ms p95={pct(total, 95):.0f}ms"
    )


def main() -> int:
    ap = argparse.ArgumentParser(description="Probe pai.ink reachability")
    ap.add_argument("base", help="Base URL, e.g. https://pai.ink")
    ap.add_argument("--runs", type=int, default=20)
    ap.add_argument("--paths", default="/,/finance/,/web3/,/about.html",
                    help="Comma-separated paths to probe")
    ap.add_argument("--out", default=None, help="CSV output path")
    args = ap.parse_args()

    paths = [p.strip() for p in args.paths.split(",") if p.strip()]
    base = args.base.rstrip("/")
    targets = [base + p for p in paths]

    hostname = socket.gethostname()
    ts = dt.datetime.now().strftime("%Y%m%dT%H%M%S")
    out_path = Path(args.out) if args.out else Path(f"latency-{hostname}-{ts}.csv")

    all_rows: list[dict] = []
    print(f"probing {len(targets)} URL(s) × {args.runs} runs from {hostname}")
    for target in targets:
        rows: list[dict] = []
        for i in range(args.runs):
            r = probe(target)
            r["run"] = i
            r["host"] = hostname
            rows.append(r)
        print("  " + summarize(rows, target))
        all_rows.extend(rows)

    with out_path.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=[
            "host", "url", "run", "dns_ms", "connect_ms", "ttfb_ms",
            "total_ms", "bytes", "status", "ok", "error",
        ])
        w.writeheader()
        for r in all_rows:
            w.writerow(r)
    print(f"wrote {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
