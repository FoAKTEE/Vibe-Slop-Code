#!/usr/bin/env python3
"""What a server tree holds that is tied to a platform. Shared by build-server.sh, which
prunes with it, and verify-server.sh, which refuses with it. Stdlib only, Python 3.9+.

    natives.py scan <root>             one line per native binary, tab-separated:
                                       format (elf|macho|pe), machine, glibc, glibcxx, path
    natives.py foreign <root> <arch>   the packages under any node_modules whose
                                       package.json os/cpu exclude linux/<arch>

Binaries are recognised by their magic, not by their name. glibc/glibcxx are the newest
GLIBC_x.y / GLIBCXX_x.y.z version names found in an ELF file ('-' when there is none): a
binary keeps the name of every symbol version it needs in .dynstr, so this can overstate
what `readelf --version-info` reports, never understate it.
"""
import json
import os
import re
import struct
import sys

ELF_MACHINES = {3: "i386", 40: "arm", 62: "x86_64", 183: "aarch64", 243: "riscv"}
MACHO_CPUS = {7: "i386", 0x01000007: "x86_64", 12: "arm", 0x0100000C: "aarch64"}
PE_MACHINES = {0x14C: "i386", 0x8664: "x86_64", 0xAA64: "aarch64"}
GLIBC = re.compile(rb"GLIBC_(\d+)\.(\d+)(?:\.(\d+))?\x00")
GLIBCXX = re.compile(rb"GLIBCXX_(\d+)\.(\d+)(?:\.(\d+))?\x00")


def newest(pattern, data):
    found = [tuple(int(part or 0) for part in match.groups()) for match in pattern.finditer(data)]
    if not found:
        return "-"
    best = max(found)
    return ".".join(str(part) for part in (best if best[2] else best[:2]))


def identify(path):
    """(format, machine, glibc, glibcxx) of a native binary, else None."""
    with open(path, "rb") as handle:
        head = handle.read(64)
        if head[:4] == b"\x7fELF" and len(head) >= 20:
            order = ">" if head[5] == 2 else "<"
            machine = struct.unpack(order + "H", head[18:20])[0]
            data = head + handle.read()
            return "elf", ELF_MACHINES.get(machine, "em%d" % machine), newest(GLIBC, data), newest(GLIBCXX, data)
        magic = head[:4].hex()
        if magic in ("cffaedfe", "cefaedfe") and len(head) >= 8:
            cpu = struct.unpack("<I", head[4:8])[0]
            return "macho", MACHO_CPUS.get(cpu, "cpu%d" % cpu), "-", "-"
        if magic in ("feedfacf", "feedface") and len(head) >= 8:
            cpu = struct.unpack(">I", head[4:8])[0]
            return "macho", MACHO_CPUS.get(cpu, "cpu%d" % cpu), "-", "-"
        # A fat Mach-O shares its magic with Java class files, which carry a version >= 45 here.
        if magic in ("cafebabe", "cafebabf") and len(head) >= 8 and struct.unpack(">I", head[4:8])[0] < 32:
            return "macho", "universal", "-", "-"
        if head[:2] == b"MZ" and len(head) >= 64:
            offset = struct.unpack("<I", head[60:64])[0]
            handle.seek(offset)
            pe = handle.read(6)
            if pe[:4] == b"PE\x00\x00" and len(pe) == 6:
                machine = struct.unpack("<H", pe[4:6])[0]
                return "pe", PE_MACHINES.get(machine, "pe%d" % machine), "-", "-"
    return None


def files(root):
    for folder, _, names in os.walk(root):
        for name in sorted(names):
            path = os.path.join(folder, name)
            if os.path.isfile(path) and not os.path.islink(path):
                yield path


def scan(root):
    for path in files(root):
        found = identify(path)
        if found:
            print("\t".join(found + (os.path.relpath(path, root),)))


def foreign(root, arch):
    for path in files(root):
        folder = os.path.dirname(path)
        if os.path.basename(path) != "package.json" or "node_modules" not in folder.split(os.sep):
            continue
        try:
            with open(path, encoding="utf-8") as handle:
                manifest = json.load(handle)
        except (OSError, ValueError):
            continue
        if not isinstance(manifest, dict):
            continue
        if not allows(manifest.get("os"), "linux") or not allows(manifest.get("cpu"), arch):
            print(os.path.relpath(folder, root))


def allows(field, value):
    """npm's os/cpu semantics: absent allows all, '!x' entries exclude, others include."""
    if not isinstance(field, list) or not field:
        return True
    if "!" + value in field:
        return False
    wanted = [entry for entry in field if not str(entry).startswith("!")]
    return not wanted or value in wanted


def main(argv):
    if len(argv) == 3 and argv[1] == "scan" and os.path.isdir(argv[2]):
        scan(argv[2])
    elif len(argv) == 4 and argv[1] == "foreign" and os.path.isdir(argv[2]):
        foreign(argv[2], argv[3])
    else:
        sys.stderr.write("usage: natives.py scan <root> | foreign <root> <arch>\n")
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
