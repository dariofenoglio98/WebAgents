"""Destination address policy shared by every outbound host transport.

`ipaddress.is_global` alone is insufficient: multicast and the NAT64 well-known
prefix are reported as global, and IPv6 can embed an IPv4 destination. This
module names each rejected class so callers can report a precise reason instead
of a single boolean. It is stdlib-only and imports no execution module.
"""

from __future__ import annotations

import ipaddress

# Addresses that are publicly routable but serve host metadata/credentials.
METADATA_ADDRESSES = frozenset(
    {
        "169.254.169.254",  # AWS/GCP/Azure/DigitalOcean instance metadata
        "169.254.170.2",  # ECS task metadata
        "100.100.100.200",  # Alibaba Cloud metadata
        "192.0.0.192",  # Oracle Cloud metadata
        "fd00:ec2::254",  # AWS IPv6 instance metadata
    }
)
# Well-known NAT64 prefixes translate an embedded IPv4 destination.
NAT64_NETWORKS = (
    ipaddress.ip_network("64:ff9b::/96"),
    ipaddress.ip_network("64:ff9b:1::/48"),
)


def public_address_reason(address: str | ipaddress.IPv4Address | ipaddress.IPv6Address):
    """Return a rejection reason, or None when the address may be contacted.

    Reasons are stable identifiers intended for audit records and API errors.
    """
    try:
        ip = ipaddress.ip_address(address)
    except ValueError:
        return "unparsable_address"
    if str(ip) in METADATA_ADDRESSES or (
        getattr(ip, "ipv4_mapped", None) is not None and str(ip.ipv4_mapped) in METADATA_ADDRESSES
    ):
        return "cloud_metadata_address"
    if ip.is_unspecified:
        return "unspecified_address"
    if ip.is_loopback:
        return "loopback_address"
    if ip.is_link_local:
        return "link_local_address"
    if ip.is_multicast:
        return "multicast_address"
    # Embedded-IPv4 forms are named before the broad buckets: "nat64_address" tells
    # an operator far more than "reserved_address" about what was attempted.
    if ip.version == 6:
        if ip.ipv4_mapped is not None:
            return "ipv4_mapped_address"
        if ip.sixtofour is not None:
            return "sixtofour_address"
        if ip.teredo is not None:
            return "teredo_address"
        if any(ip in network for network in NAT64_NETWORKS):
            return "nat64_address"
    if ip.is_reserved:
        return "reserved_address"
    if ip.is_private:
        return "private_address"
    if not ip.is_global:
        return "non_global_address"
    return None


def is_public_address(address) -> bool:
    return public_address_reason(address) is None


def is_loopback_host(hostname: str) -> bool:
    """True only for literal loopback addresses and the reserved localhost name."""
    name = hostname.strip().strip("[]").lower()
    if name in {"localhost", "ip6-localhost", "ip6-loopback"} or name.endswith(".localhost"):
        return True
    try:
        return ipaddress.ip_address(name).is_loopback
    except ValueError:
        return False
