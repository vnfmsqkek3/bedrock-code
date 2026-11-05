"""
Lightweight RSA RS256 JWT signature verification using only Python stdlib.

No external dependencies required (no PyJWT, no cryptography library).
Uses the built-in `rsa` operations via `int.from_bytes` and modular exponentiation.
"""

import base64
import hashlib
import json
import struct


def _base64url_decode(s: str) -> bytes:
    """Decode base64url without padding."""
    s += "=" * (4 - len(s) % 4)
    return base64.urlsafe_b64decode(s)


def _int_from_base64url(s: str) -> int:
    """Convert base64url-encoded big-endian integer."""
    return int.from_bytes(_base64url_decode(s), byteorder="big")


def verify_rs256(token: str, jwk: dict) -> bool:
    """
    Verify an RS256 JWT signature against a JWK public key.

    Args:
        token: The complete JWT string (header.payload.signature)
        jwk: The JWK dict with 'n' and 'e' fields (RSA public key)

    Returns:
        True if signature is valid

    Raises:
        ValueError: if signature verification fails
    """
    parts = token.split(".")
    if len(parts) != 3:
        raise ValueError("Invalid JWT: expected 3 parts")

    # The signed data is "header.payload" (ASCII bytes)
    signed_data = f"{parts[0]}.{parts[1]}".encode("ascii")

    # Decode the signature
    signature = _base64url_decode(parts[2])

    # Extract RSA public key components
    n = _int_from_base64url(jwk["n"])
    e = _int_from_base64url(jwk["e"])

    # RSA verification: signature^e mod n
    key_size = (n.bit_length() + 7) // 8
    sig_int = int.from_bytes(signature, byteorder="big")

    # Perform RSA public key operation
    decrypted_int = pow(sig_int, e, n)
    decrypted_bytes = decrypted_int.to_bytes(key_size, byteorder="big")

    # PKCS#1 v1.5 signature verification
    # Expected format: 0x00 0x01 [padding 0xFF...] 0x00 [DigestInfo]
    # DigestInfo for SHA-256: 30 31 30 0d 06 09 60 86 48 01 65 03 04 02 01 05 00 04 20 [32-byte hash]
    SHA256_DIGEST_INFO_PREFIX = bytes([
        0x30, 0x31, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86,
        0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01, 0x05,
        0x00, 0x04, 0x20
    ])

    # Compute SHA-256 of the signed data
    expected_hash = hashlib.sha256(signed_data).digest()

    # Build expected PKCS#1 v1.5 padded message
    digest_info = SHA256_DIGEST_INFO_PREFIX + expected_hash
    padding_len = key_size - 3 - len(digest_info)
    if padding_len < 8:
        raise ValueError("Key too short for PKCS#1 v1.5 padding")

    expected_padded = b"\x00\x01" + (b"\xff" * padding_len) + b"\x00" + digest_info

    if decrypted_bytes != expected_padded:
        raise ValueError("RSA signature verification failed")

    return True
