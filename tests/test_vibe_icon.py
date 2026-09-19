"""App icon for Vibe Slop Code: a directed hypergraph of five rectangular nodes.

The sources are hand-written SVGs under `branding/`; `scripts/make-icon.sh`
renders them into the platform files at their upstream checkout paths. Checked here,
with the standard library only (the platform files are parsed by hand):

  * the SVG contract: well-formed ASCII XML, exactly five `<rect data-node>` that are
    rectangles and not pills, at least one `data-junction` naming the node its arrow
    enters, no text, no raster, no reference that leaves the file; the monochrome mark
    paints with `currentColor` only;
  * the script parses, is executable, and names the tool it is missing;
  * a render into a scratch directory (`--out`): the `.icns` table of contents and the
    size of every PNG inside it, the `.png` headers and chunk lists (no timestamps,
    no text chunks), the `.ico` directories, the in-workbench SVGs' size contracts;
  * two renders are byte-identical, `--check` accepts a fresh render without writing
    and rejects it once a source SVG changed.

The render tests skip when `rsvg-convert`, `magick` or `iconutil` is absent.
"""
from __future__ import annotations

import os
import shutil
import struct
import subprocess
import xml.etree.ElementTree as ET
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
BRANDING = REPO_ROOT / "branding"
MAKE_ICON = REPO_ROOT / "scripts" / "make-icon.sh"
CHECKOUT = REPO_ROOT / "vscode"

SVG_NS = "{http://www.w3.org/2000/svg}"
RENDER_TOOLS = ("rsvg-convert", "magick", "iconutil")

# source -> viewBox it must keep (make-icon.sh and upstream's CSS rely on them)
SOURCES = {
    "icon.svg": "0 0 1024 1024",
    "icon-small.svg": "0 0 1024 1024",
    "mark.svg": "0 0 260 260",
}

ICNS = "resources/darwin/code.icns"
PNGS = {
    "resources/linux/code.png": 1024,
    "resources/server/code-192.png": 192,
    "resources/server/code-512.png": 512,
    "resources/win32/code_150x150.png": 150,
    "resources/win32/code_70x70.png": 70,
}
ICOS = {
    "resources/win32/code.ico": [16, 24, 32, 48, 64, 128, 256],
    "resources/server/favicon.ico": [16, 24, 32, 48, 64],
}
WORKBENCH_SVGS = {
    "src/vs/workbench/browser/media/code-icon.svg": ("0 0 1024 1024", None),
    "src/vs/workbench/browser/parts/editor/media/letterpress-dark.svg": ("0 0 260 260", "260"),
    "src/vs/workbench/browser/parts/editor/media/letterpress-light.svg": ("0 0 260 260", "260"),
    "src/vs/workbench/browser/parts/editor/media/letterpress-hcDark.svg": ("0 0 260 260", "260"),
    "src/vs/workbench/browser/parts/editor/media/letterpress-hcLight.svg": ("0 0 260 260", "260"),
}
ALL_OUTPUTS = [ICNS, *PNGS, *ICOS, *WORKBENCH_SVGS]

# icns entry type -> pixel size of the PNG it holds
ICNS_PNG_TYPES = {
    b"ic07": 128, b"ic08": 256, b"ic09": 512, b"ic10": 1024,
    b"ic11": 32, b"ic12": 64, b"ic13": 256, b"ic14": 512,
}
# 16 and 32 px: iconutil stores them as ARGB (ic04/ic05); older ones as PNG or RLE
ICNS_SMALL_TYPES = ({b"ic04", b"icp4", b"is32"}, {b"ic05", b"icp5", b"il32"})

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
# what make-icon.sh writes itself holds pixels only; iconutil re-encodes the PNGs it
# packs (adding sRGB and eXIf), so inside the .icns only dates and text are ruled out
PNG_PIXEL_CHUNKS = {b"IHDR", b"PLTE", b"tRNS", b"IDAT", b"IEND"}
PNG_DATED_CHUNKS = {b"tIME", b"tEXt", b"zTXt", b"iTXt"}


def run(cmd: list[str], env: dict[str, str] | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, timeout=300,
                          cwd=str(REPO_ROOT), env={**os.environ, **(env or {})})


def png_chunks(data: bytes) -> list[tuple[bytes, bytes]]:
    assert data[:8] == PNG_SIGNATURE
    chunks, offset = [], 8
    while offset < len(data):
        (length,) = struct.unpack(">I", data[offset:offset + 4])
        chunks.append((data[offset + 4:offset + 8], data[offset + 8:offset + 8 + length]))
        offset += 12 + length
    assert offset == len(data)
    return chunks


def png_size(data: bytes) -> tuple[int, int]:
    kind, body = png_chunks(data)[0]
    assert kind == b"IHDR"
    return struct.unpack(">II", body[:8])


def icns_entries(data: bytes) -> list[tuple[bytes, bytes]]:
    assert data[:4] == b"icns"
    assert struct.unpack(">I", data[4:8])[0] == len(data)
    entries, offset = [], 8
    while offset < len(data):
        (length,) = struct.unpack(">I", data[offset + 4:offset + 8])
        assert length >= 8
        entries.append((data[offset:offset + 4], data[offset + 8:offset + length]))
        offset += length
    assert offset == len(data)
    return entries


def ico_sizes(data: bytes) -> list[int]:
    reserved, kind, count = struct.unpack("<HHH", data[:6])
    assert (reserved, kind) == (0, 1)
    sizes = []
    for index in range(count):
        width, height, _, _, _, _, length, offset = struct.unpack(
            "<BBBBHHII", data[6 + 16 * index:22 + 16 * index])
        assert width == height
        assert offset + length <= len(data)
        sizes.append(width or 256)
    return sizes


# ---------------------------------------------------------------- SVG sources

def parse(name: str) -> ET.Element:
    raw = (BRANDING / name).read_bytes()
    raw.decode("ascii")
    assert b"\r" not in raw
    return ET.fromstring(raw)


def local(element: ET.Element) -> str:
    return element.tag.replace(SVG_NS, "")


@pytest.mark.parametrize("name", sorted(SOURCES))
def test_source_is_a_five_node_hypergraph(name: str) -> None:
    root = parse(name)
    assert root.tag == SVG_NS + "svg"
    assert root.get("viewBox") == SOURCES[name]

    nodes = [e for e in root.iter() if e.get("data-node") is not None]
    assert len(nodes) == 5
    assert all(local(e) == "rect" for e in nodes)
    ids = [e.get("data-node") for e in nodes]
    assert len(set(ids)) == 5 and all(ids)
    for rect in nodes:
        width, height = float(rect.get("width")), float(rect.get("height"))
        assert width > 0 and height > 0
        # a rectangle with softened corners, never a pill or a disc
        assert float(rect.get("rx", "0")) <= min(width, height) / 4
    # every rectangle in the drawing is a node (or the tile behind them)
    others = [e for e in root.iter(SVG_NS + "rect")
              if e.get("data-node") is None and e.get("data-tile") is None]
    assert others == []

    junctions = [e for e in root.iter() if e.get("data-junction") is not None]
    assert junctions
    for junction in junctions:
        assert junction.get("data-junction") in ids


@pytest.mark.parametrize("name", sorted(SOURCES))
def test_source_is_self_contained(name: str) -> None:
    root = parse(name)
    forbidden = {"text", "tspan", "image", "use", "style", "script", "foreignObject",
                 "filter", "a"}
    assert not [local(e) for e in root.iter() if local(e) in forbidden]
    for element in root.iter():
        for key, value in element.attrib.items():
            assert not key.endswith("href"), key
            assert "://" not in value and "url(" not in value, (key, value)
    text = (BRANDING / name).read_text(encoding="ascii")
    assert "<!DOCTYPE" not in text and "<?xml-stylesheet" not in text


@pytest.mark.parametrize("name", ["icon.svg", "icon-small.svg"])
def test_app_icon_sits_on_one_tile(name: str) -> None:
    tiles = [e for e in parse(name).iter() if e.get("data-tile") is not None]
    assert len(tiles) == 1 and local(tiles[0]) == "rect"
    tile = tiles[0]
    border = float(tile.get("stroke-width", "0"))  # painted half outside the rect
    x, y = float(tile.get("x")) - border / 2, float(tile.get("y")) - border / 2
    width, height = float(tile.get("width")) + border, float(tile.get("height")) + border
    assert width == height and x == y and x + width + x == 1024
    if name == "icon.svg":
        # the macOS grid: an 824 px tile centred on the 1024 px canvas
        assert (x, width) == (100, 824)
    for rect in parse(name).iter(SVG_NS + "rect"):
        if rect.get("data-node") is None:
            continue
        assert x < float(rect.get("x")) and float(rect.get("x")) + float(rect.get("width")) < x + width
        assert y < float(rect.get("y")) and float(rect.get("y")) + float(rect.get("height")) < y + height


def test_small_variant_is_drawn_on_the_pixel_grid() -> None:
    """One 16 px pixel is 64 units: every node edge of the small variant sits on it."""
    for rect in parse("icon-small.svg").iter(SVG_NS + "rect"):
        for key in ("x", "y", "width", "height"):
            assert float(rect.get(key)) % 64 == 0, (rect.attrib, key)


def test_mark_paints_with_current_color_only() -> None:
    root = parse("mark.svg")
    assert root.get("width") == "260" and root.get("height") == "260"
    paints = set()
    for element in root.iter():
        for key in ("fill", "stroke", "color", "stop-color"):
            if element.get(key) is not None:
                paints.add(element.get(key))
    assert "currentColor" in paints
    assert paints <= {"currentColor", "none"}


# --------------------------------------------------------------------- script

def test_script_parses_and_is_executable() -> None:
    assert run(["bash", "-n", str(MAKE_ICON)]).returncode == 0
    assert os.access(MAKE_ICON, os.X_OK)
    text = MAKE_ICON.read_text(encoding="ascii")
    assert text.startswith("#!/usr/bin/env bash\n#")
    assert "set -euo pipefail" in text and "env.sh" in text
    assert not [line for line in text.splitlines() if line.startswith("  ")]


def test_script_rejects_unknown_arguments(tmp_path: Path) -> None:
    for args in (["--nope"], ["--out"], ["--out", str(tmp_path), "extra"]):
        result = run([str(MAKE_ICON), *args])
        assert result.returncode == 2, args
        assert "usage:" in result.stderr
    assert list(tmp_path.iterdir()) == []


def test_script_names_the_missing_tool(tmp_path: Path) -> None:
    """With a PATH that holds nothing but `dirname`, the first render tool is missing."""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    (bin_dir / "dirname").symlink_to(shutil.which("dirname"))
    out = tmp_path / "out"
    result = run([shutil.which("bash"), str(MAKE_ICON), "--out", str(out)],
                 env={"PATH": str(bin_dir)})
    assert result.returncode == 1
    assert "rsvg-convert" in result.stderr and "not found" in result.stderr
    assert not out.exists()


# --------------------------------------------------------------------- render

needs_tools = pytest.mark.skipif(
    any(shutil.which(tool) is None for tool in RENDER_TOOLS),
    reason="needs " + ", ".join(RENDER_TOOLS))


@pytest.fixture(scope="module")
def rendered(tmp_path_factory: pytest.TempPathFactory) -> Path:
    out = tmp_path_factory.mktemp("icon") / "out"
    result = run([str(MAKE_ICON), "--out", str(out)])
    assert result.returncode == 0, result.stderr
    return out


@needs_tools
def test_render_writes_exactly_the_platform_files(rendered: Path) -> None:
    found = sorted(str(p.relative_to(rendered)) for p in rendered.rglob("*") if p.is_file())
    assert found == sorted(ALL_OUTPUTS)


@needs_tools
def test_icns_holds_every_size(rendered: Path) -> None:
    data = (rendered / ICNS).read_bytes()
    entries = dict(icns_entries(data))
    for kind, size in ICNS_PNG_TYPES.items():
        assert kind in entries, kind
        assert png_size(entries[kind]) == (size, size), kind
    for alternatives in ICNS_SMALL_TYPES:
        assert alternatives & set(entries), alternatives
    assert len(data) < 400_000


@needs_tools
def test_pngs_have_the_right_size_and_no_metadata(rendered: Path) -> None:
    for path, size in PNGS.items():
        data = (rendered / path).read_bytes()
        assert png_size(data) == (size, size), path
        assert {kind for kind, _ in png_chunks(data)} <= PNG_PIXEL_CHUNKS, path
    for kind, body in icns_entries((rendered / ICNS).read_bytes()):
        if kind in ICNS_PNG_TYPES:
            assert not {k for k, _ in png_chunks(body)} & PNG_DATED_CHUNKS, kind


@needs_tools
def test_icos_hold_every_size(rendered: Path) -> None:
    for path, sizes in ICOS.items():
        assert ico_sizes((rendered / path).read_bytes()) == sizes, path


@needs_tools
def test_workbench_svgs_keep_upstream_size_contracts(rendered: Path) -> None:
    for path, (view_box, size) in WORKBENCH_SVGS.items():
        raw = (rendered / path).read_bytes()
        raw.decode("ascii")
        root = ET.fromstring(raw)
        assert root.get("viewBox") == view_box, path
        assert root.get("width") == size and root.get("height") == size, path
        assert len([e for e in root.iter() if e.get("data-node") is not None]) == 5, path
        assert b"currentColor" not in raw, path  # a CSS background image has no colour to inherit


@needs_tools
def test_render_is_byte_identical_across_runs(rendered: Path, tmp_path: Path) -> None:
    again = tmp_path / "again"
    assert run([str(MAKE_ICON), "--out", str(again)]).returncode == 0
    for path in ALL_OUTPUTS:
        assert (again / path).read_bytes() == (rendered / path).read_bytes(), path


@needs_tools
def test_check_accepts_a_fresh_render_and_rejects_a_stale_one(rendered: Path, tmp_path: Path) -> None:
    before = {path: (rendered / path).read_bytes() for path in ALL_OUTPUTS}
    fresh = run([str(MAKE_ICON), "--check", "--out", str(rendered)])
    assert fresh.returncode == 0, fresh.stderr

    branding = tmp_path / "branding"
    shutil.copytree(BRANDING, branding)
    master = branding / "icon.svg"
    text = master.read_text(encoding="ascii")
    node = next(e for e in ET.fromstring(text).iter() if e.get("data-node") is not None)
    moved = text.replace(f'data-node="{node.get("data-node")}" x="{node.get("x")}"',
                         f'data-node="{node.get("data-node")}" x="{float(node.get("x")) + 8:g}"')
    assert moved != text
    master.write_text(moved, encoding="ascii")
    stale = run([str(MAKE_ICON), "--check", "--out", str(rendered)],
                env={"VIBE_BRANDING": str(branding)})
    assert stale.returncode == 1
    assert ICNS in stale.stderr and "code.ico" in stale.stderr
    # the in-workbench app icon is the untouched small variant
    assert "code-icon.svg" not in stale.stderr

    assert {path: (rendered / path).read_bytes() for path in ALL_OUTPUTS} == before


@needs_tools
def test_check_reports_a_missing_file(rendered: Path, tmp_path: Path) -> None:
    partial = tmp_path / "partial"
    shutil.copytree(rendered, partial)
    (partial / ICNS).unlink()
    result = run([str(MAKE_ICON), "--check", "--out", str(partial)])
    assert result.returncode == 1 and ICNS in result.stderr


@needs_tools
@pytest.mark.skipif(not (CHECKOUT / ICNS).exists(), reason="no upstream checkout")
def test_checkout_carries_the_current_icon() -> None:
    result = run([str(MAKE_ICON), "--check"])
    assert result.returncode == 0, result.stderr
