"""RFC 8785 JSON Canonicalization Scheme (JCS).

Minimal implementation sufficient for ai-audit manifests:
- Object keys sorted lexicographically by codepoint.
- No insignificant whitespace.
- Strings escaped per RFC 8259 with the minimal set.
- Numbers serialized as ECMAScript Number.prototype.toString(), which for
  integers we hold matches Python's repr; for floats we use the same
  algorithm shortest-round-trip form via repr().

We deliberately reject NaN / Infinity (not valid JSON anyway).
"""

from __future__ import annotations

import math
from typing import Any


def _encode_string(s: str) -> str:
    out = ['"']
    for ch in s:
        code = ord(ch)
        if ch == '"':
            out.append('\\"')
        elif ch == "\\":
            out.append("\\\\")
        elif ch == "\b":
            out.append("\\b")
        elif ch == "\f":
            out.append("\\f")
        elif ch == "\n":
            out.append("\\n")
        elif ch == "\r":
            out.append("\\r")
        elif ch == "\t":
            out.append("\\t")
        elif code < 0x20:
            out.append(f"\\u{code:04x}")
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def _encode_number(n: Any) -> str:
    if isinstance(n, bool):
        # bool is subclass of int; handled by caller, but be defensive
        return "true" if n else "false"
    if isinstance(n, int):
        return str(n)
    if isinstance(n, float):
        if math.isnan(n) or math.isinf(n):
            raise ValueError("NaN/Infinity not allowed in JCS")
        if n == 0:
            return "0"
        # repr() produces the shortest round-trippable form for Python floats.
        # For integer-valued floats, JCS expects no trailing ".0".
        if n.is_integer() and abs(n) < 1e21:
            return str(int(n))
        return repr(n)
    raise TypeError(f"Unsupported number type: {type(n)}")


def canonicalize(value: Any) -> bytes:
    """Return the JCS-canonical UTF-8 bytes of `value`."""
    return _emit(value).encode("utf-8")


def _emit(v: Any) -> str:
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return _encode_number(v)
    if isinstance(v, str):
        return _encode_string(v)
    if isinstance(v, list):
        return "[" + ",".join(_emit(x) for x in v) + "]"
    if isinstance(v, dict):
        items = sorted(v.items(), key=lambda kv: kv[0])
        return "{" + ",".join(_encode_string(k) + ":" + _emit(val) for k, val in items) + "}"
    raise TypeError(f"Cannot canonicalize value of type {type(v)}")
