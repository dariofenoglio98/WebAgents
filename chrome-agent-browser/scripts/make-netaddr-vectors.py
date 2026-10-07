"""Vectors for the Node CLI's port of `agentpkg.netaddr.public_address_reason`.

The Chrome CLI's transport resolves every tool and model host and refuses a non-public
destination before connecting (D-067), with the same class names the Python runtime and the
reference plugin use. This script records the reference verdict for one address of every class
and for the boundaries between them. Written by the T4 session on 2026-10-07; run from the
repository root:

    agentpkg/.venv/bin/python chrome-agent-browser/scripts/make-netaddr-vectors.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "agentpkg" / "src"))
from agentpkg.netaddr import public_address_reason  # noqa: E402

OUT = ROOT / "chrome-agent-browser" / "test" / "fixtures" / "netaddr-vectors.json"

ADDRESSES = [
    # IPv4: public
    "8.8.8.8", "1.1.1.1", "93.184.216.34", "9.255.255.255", "11.0.0.1", "172.15.255.255", "172.32.0.1",
    "100.63.255.255", "100.128.0.1", "192.167.255.255", "192.169.0.1", "198.17.255.255", "198.20.0.1",
    "198.51.99.255", "198.51.101.1", "203.0.112.255", "203.0.114.1", "223.255.255.255", "192.0.1.1",
    "192.0.0.9", "192.0.0.10", "192.88.99.1", "192.0.0.171", "192.0.0.8",
    # IPv4: refused classes and their boundaries
    "0.0.0.0", "0.1.2.3", "10.0.0.1", "10.255.255.255", "100.64.0.1", "100.127.255.255", "127.0.0.1",
    "127.255.255.255", "169.254.0.1", "169.254.169.254", "169.254.170.2", "169.254.255.255", "172.16.0.1",
    "172.31.255.255", "192.0.0.1", "192.0.0.170", "192.0.0.192", "192.0.2.1", "192.168.1.1", "198.18.0.1",
    "198.19.255.255", "198.51.100.1", "203.0.113.1", "224.0.0.1", "239.255.255.255", "240.0.0.1",
    "255.255.255.254", "255.255.255.255", "100.100.100.200",
    # IPv6: public
    "2606:2800:220:1:248:1893:25c8:1946", "2001:4860:4860::8888", "2001:200::1", "2001:1::1", "2001:1::2",
    "2001:3::1", "2001:4:112::1", "2001:20::1", "2001:2f::1", "2001:30::1", "2600::1", "3fff::1", "fec0::1",
    "64:ff9c::1", "2001:db9::1",
    # IPv6: refused classes and their boundaries
    "::", "::1", "::2", "::ffff:1.2.3.4", "::ffff:169.254.169.254", "::ffff:7f00:1", "::ffff:808:808",
    "64:ff9b::1.2.3.4", "64:ff9b::1", "64:ff9b:1::1", "64:ff9b:2::1", "100::1", "100:0:0:1::1", "100:1::1",
    "2001::1", "2001:0:1::1", "2001:1::3", "2001:2::1", "2001:10::1", "2001:40::1", "2001:1ff::1",
    "2001:db8::1", "2002:c000:204::1", "2002:808:808::1", "4000::1", "fc00::1", "fd00::1", "fd00:ec2::254",
    "fdff:ffff::1", "fe80::1", "fe80::", "febf::1", "ff02::1", "ffff::1", "200::1", "f000::1", "fe00::1",
    "fe7f::1", "::ffff:0:0", "1::1", "2001:1::0", "2001:1::3:0",
    # not addresses
    "not-an-address", "1.2.3", "1.2.3.4.5", "256.1.1.1", "fe80::1%eth0", "",
]

vectors = [{"address": address, "reason": public_address_reason(address)} for address in ADDRESSES]
OUT.write_text(json.dumps({"python": sys.version.split()[0], "vectors": vectors}, indent=2) + "\n")
counts: dict[str, int] = {}
for entry in vectors:
    counts[str(entry["reason"])] = counts.get(str(entry["reason"]), 0) + 1
print(f"wrote {OUT} ({len(vectors)} vectors)")
for reason, count in sorted(counts.items()):
    print(f"  {reason}: {count}")
