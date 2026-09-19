"""Packaging Vibe Slop Code: ``scripts/package.sh`` and ``scripts/verify-package.sh``.

Nothing here builds anything. ``package.sh`` is a wrapper around upstream's gulp
task, so only its task mapping and its refusals are exercised: ``--print-task``
prints the task it *would* run, ``VIBE_UNAME_S`` / ``VIBE_UNAME_M`` drive the host
mapping (so the linux tasks are covered from macOS), and a fake ``npm`` first on
PATH proves that no build was started.

``verify-package.sh`` is checked against a fake bundle under ``tmp_path`` — one
good tree plus a broken variant per check, with the bundled CLI stubbed by a
three-line shell script — and, when it exists, against the real packaged app.
Both are read-only.
"""
from __future__ import annotations

import json
import os
import platform
import plistlib
import re
import shutil
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
VIBE = REPO / "vibe"
SCRIPTS = VIBE / "scripts"
PACKAGE = SCRIPTS / "package.sh"
VERIFY = SCRIPTS / "verify-package.sh"

APP_NAME = "Vibe Slop Code.app"
# The bundle name before the rename: a packaged tree keeps it until the next package.sh.
LEGACY_APP_NAME = "Vibe Studio Code.app"
ARCH = {"arm64": "arm64", "aarch64": "arm64", "x86_64": "x64", "amd64": "x64"}.get(platform.machine(), "")
# macOS ships bash 3.2 at /bin/bash; run the scripts under it so compatibility is tested.
BASH = "/bin/bash" if Path("/bin/bash").exists() else shutil.which("bash")
PLISTBUDDY = Path("/usr/libexec/PlistBuddy")

FAKE_VERSION = "9.9.9"
FAKE_COMMIT = "b" * 40
GALLERY = {
    "serviceUrl": "https://open-vsx.org/vscode/gallery",
    "itemUrl": "https://open-vsx.org/vscode/item",
}
PRODUCT = {
    "nameShort": "Vibe",
    "nameLong": "Vibe Slop Code",
    "applicationName": "vibe",
    "dataFolderName": ".vibe",
    "darwinBundleIdentifier": "dev.chandra.vibe",
    "version": FAKE_VERSION,
    "commit": FAKE_COMMIT,
    "date": "2026-07-17T15:35:09+00:00",
    "extensionsGallery": GALLERY,
}


# --------------------------------------------------------------------------- helpers

def write(path: Path, data: str, mode: int = 0o644) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(data, encoding="utf-8")
    path.chmod(mode)


def run(script: Path, *args: str, **env: str) -> subprocess.CompletedProcess:
    base = {k: v for k, v in os.environ.items() if not k.startswith("VIBE_")}
    return subprocess.run([BASH, str(script), *args], cwd=str(REPO), capture_output=True,
                          text=True, timeout=120, env={**base, **env})


def snapshot(root: Path) -> dict[str, bytes]:
    return {p.relative_to(root).as_posix(): p.read_bytes()
            for p in sorted(root.rglob("*")) if p.is_file()}


def fake_npm(tmp: Path) -> tuple[str, Path]:
    """A PATH whose `npm` only records that it was called, and the record's path."""
    marker = tmp / "npm-was-run"
    write(tmp / "fakebin" / "npm", f'#!/usr/bin/env bash\necho "$*" >> "{marker}"\n', 0o755)
    return f"{tmp / 'fakebin'}:{os.environ['PATH']}", marker


# --------------------------------------------------------------------------- static

@pytest.mark.parametrize("script", [PACKAGE, VERIFY], ids=["package.sh", "verify-package.sh"])
def test_script_exists_executable_and_parses(script: Path) -> None:
    assert script.is_file(), f"missing {script}"
    assert os.access(script, os.X_OK), f"{script.name} is not executable"
    proc = subprocess.run([BASH, "-n", str(script)], capture_output=True, text=True)
    assert proc.returncode == 0, proc.stderr
    text = script.read_text(encoding="utf-8")
    assert text.startswith("#!/usr/bin/env bash\n")
    assert "\nset -euo pipefail\n" in text
    assert '. "$(dirname "${BASH_SOURCE[0]}")/env.sh"' in text
    banned = re.search(r"\b(mapfile|readarray)\b|declare -A|local -n|\$\{[^}]*(\^\^|,,)\}", text)
    assert not banned, f"{script.name}: bash 4+ construct {banned.group(0)!r}"


def test_readme_documents_packaging() -> None:
    readme = (VIBE / "README.md").read_text(encoding="utf-8")
    for needle in ("package.sh", "verify-package.sh", "install-cli.sh", "VSCode-darwin", "newest"):
        assert needle in readme, f"README does not mention {needle}"


# --------------------------------------------------------------------------- package.sh mapping

HOST_CASES = [
    ("Darwin", "arm64", [], "vscode-darwin-arm64"),
    ("Darwin", "x86_64", [], "vscode-darwin-x64"),
    ("Linux", "x86_64", [], "vscode-linux-x64"),
    ("Linux", "aarch64", [], "vscode-linux-arm64"),
    ("Darwin", "arm64", ["--arch", "x64"], "vscode-darwin-x64"),
    ("Darwin", "x86_64", ["--arch", "arm64"], "vscode-darwin-arm64"),
    ("Darwin", "arm64", ["--min"], "vscode-darwin-arm64-min"),
    ("Linux", "aarch64", ["--arch", "x64", "--min"], "vscode-linux-x64-min"),
]


@pytest.mark.parametrize("uname_s,uname_m,args,task", HOST_CASES,
                         ids=[f"{s}-{m}{''.join(a)}" for s, m, a, _ in HOST_CASES])
def test_print_task_maps_host_and_flags(tmp_path: Path, uname_s: str, uname_m: str,
                                        args: list[str], task: str) -> None:
    """The mapping is pure: no checkout, no toolchain, nothing executed."""
    path, marker = fake_npm(tmp_path)
    proc = run(PACKAGE, *args, "--print-task", VIBE_UNAME_S=uname_s, VIBE_UNAME_M=uname_m,
               VIBE_CHECKOUT=str(tmp_path / "no-checkout"),
               VIBE_TOOLCHAIN=str(tmp_path / "no-toolchain"), PATH=path)
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout.strip() == task
    assert not marker.exists(), "--print-task must not run anything"


def test_print_task_for_this_host(tmp_path: Path) -> None:
    arch = {"arm64": "arm64", "aarch64": "arm64", "x86_64": "x64", "amd64": "x64"}[platform.machine()]
    expected = f"vscode-{platform.system().lower()}-{arch}"
    proc = run(PACKAGE, "--print-task", VIBE_TOOLCHAIN=str(tmp_path / "no-toolchain"))
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout.strip() == expected


@pytest.mark.parametrize("args", [["--nope"], ["--arch"], ["--arch", "riscv"], ["extra"]])
def test_bad_arguments_are_rejected(tmp_path: Path, args: list[str]) -> None:
    path, marker = fake_npm(tmp_path)
    proc = run(PACKAGE, *args, "--print-task", PATH=path,
               VIBE_TOOLCHAIN=str(tmp_path / "no-toolchain"))
    assert proc.returncode == 2, proc.stdout
    assert "usage" in proc.stderr
    assert not marker.exists()


def test_unsupported_platform_is_refused(tmp_path: Path) -> None:
    proc = run(PACKAGE, "--print-task", VIBE_UNAME_S="Plan9", VIBE_UNAME_M="x86_64",
               VIBE_TOOLCHAIN=str(tmp_path / "no-toolchain"))
    assert proc.returncode != 0
    assert "Plan9" in proc.stderr


def test_unsupported_machine_is_refused(tmp_path: Path) -> None:
    proc = run(PACKAGE, "--print-task", VIBE_UNAME_S="Linux", VIBE_UNAME_M="ppc64le",
               VIBE_TOOLCHAIN=str(tmp_path / "no-toolchain"))
    assert proc.returncode != 0
    assert "ppc64le" in proc.stderr and "--arch" in proc.stderr


# --------------------------------------------------------------------------- package.sh refusals

def test_missing_checkout_is_refused(tmp_path: Path) -> None:
    empty = tmp_path / "empty"
    empty.mkdir()
    path, marker = fake_npm(tmp_path)
    proc = run(PACKAGE, VIBE_CHECKOUT=str(empty), PATH=path,
               VIBE_TOOLCHAIN=str(tmp_path / "no-toolchain"))
    assert proc.returncode != 0
    assert str(empty) in proc.stderr and "bootstrap.sh" in proc.stderr
    assert not marker.exists(), "a refused package.sh must not start a build"


def test_missing_node_modules_is_refused(tmp_path: Path) -> None:
    checkout = tmp_path / "vscode"
    write(checkout / "package.json", json.dumps({"version": FAKE_VERSION}))
    path, marker = fake_npm(tmp_path)
    proc = run(PACKAGE, VIBE_CHECKOUT=str(checkout), PATH=path,
               VIBE_TOOLCHAIN=str(tmp_path / "no-toolchain"))
    assert proc.returncode != 0
    assert "node_modules" in proc.stderr and "bootstrap.sh" in proc.stderr
    assert not marker.exists()


# --------------------------------------------------------------------------- package.sh siblings

def fake_checkout(tmp: Path) -> Path:
    """The few files package.sh reads before it hands over to gulp."""
    checkout = tmp / "vscode"
    write(checkout / "package.json", json.dumps({"version": FAKE_VERSION}))
    write(checkout / "node_modules" / ".keep", "")
    write(checkout / "product.json", '{\n\t"nameLong": "Vibe Slop Code"\n}\n')
    return checkout


def package_with_bundles(tmp: Path, *names: str) -> subprocess.CompletedProcess:
    """package.sh with a fake npm and the bundles gulp would have written already in
    place — the run itself builds nothing."""
    checkout = fake_checkout(tmp)
    for name in names:
        (tmp / name / APP_NAME / "Contents").mkdir(parents=True)
    path, marker = fake_npm(tmp)
    proc = run(PACKAGE, "--arch", "arm64", VIBE_UNAME_S="Darwin", VIBE_UNAME_M="arm64",
               VIBE_ROOT=str(tmp), VIBE_CHECKOUT=str(checkout),
               VIBE_TOOLCHAIN=str(tmp / "no-toolchain"), PATH=path)
    assert marker.exists(), "package.sh never got as far as the gulp task"
    return proc


def test_sibling_bundles_are_named_and_never_removed(tmp_path: Path) -> None:
    """A stale copy under another name is what `vibe` has to sort out later; say so."""
    proc = package_with_bundles(tmp_path, "VSCode-darwin-arm64", "VSCode-darwin-arm64.next")
    assert proc.returncode == 0, proc.stdout + proc.stderr
    notes = [line for line in proc.stdout.splitlines() if line.startswith("note: ")]
    assert len(notes) == 1, proc.stdout
    assert str(tmp_path / "VSCode-darwin-arm64.next") in notes[0]
    assert notes[0].count(str(tmp_path / "VSCode-darwin-arm64")) == 1, \
        f"the fresh bundle must not be listed as its own sibling: {notes[0]}"
    assert (tmp_path / "VSCode-darwin-arm64.next" / APP_NAME).is_dir(), "nothing may be deleted"


def test_a_lone_bundle_gets_no_note(tmp_path: Path) -> None:
    proc = package_with_bundles(tmp_path, "VSCode-darwin-arm64")
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "note: " not in proc.stdout, proc.stdout


# --------------------------------------------------------------------------- verify-package.sh

class Bundle:
    """A fake packaged app, plus the checkout version and pin it is checked against."""

    def __init__(self, tmp: Path):
        self.tmp = tmp
        self.app = tmp / f"VSCode-darwin-{ARCH}" / APP_NAME
        self.res = self.app / "Contents" / "Resources" / "app"
        self.plist = self.app / "Contents" / "Info.plist"
        self.product_json = self.res / "product.json"
        self.ext = self.res / "extensions" / "vibe-chandra"
        self.cli = self.res / "bin" / "code"
        self.checkout = tmp / "vscode"
        self.pin = tmp / "upstream.json"

        self.plist.parent.mkdir(parents=True)
        self.set_identifier("dev.chandra.vibe")
        self.set_product(PRODUCT)
        write(self.res / "package.json", json.dumps({"version": FAKE_VERSION}))
        self.set_cli(FAKE_VERSION, FAKE_COMMIT, "arm64")
        # `main` is node-resolved, so the real bundle spells it without the .js suffix.
        write(self.ext / "package.json", json.dumps({"name": "vibe-chandra", "main": "./dist/extension"}))
        write(self.ext / "dist" / "extension.js", "// bundled\n")
        write(self.ext / "media" / "graph.js", "// graph\n")
        write(self.ext / "media" / "graph.css", "/* graph */\n")
        write(self.checkout / "package.json", json.dumps({"version": FAKE_VERSION}))
        # env.sh reads the pin with sed, one key per line, exactly like the real file.
        write(self.pin, json.dumps({"repo": "r", "tag": FAKE_VERSION, "commit": FAKE_COMMIT,
                                    "node": "1.2.3"}, indent=2))

    def set_identifier(self, identifier: str) -> None:
        with self.plist.open("wb") as fh:
            plistlib.dump({"CFBundleIdentifier": identifier, "CFBundleName": "Vibe"}, fh)

    def product(self) -> dict:
        return json.loads(self.product_json.read_text(encoding="utf-8"))

    def set_product(self, product: dict) -> None:
        write(self.product_json, json.dumps(product, indent=2))

    def set_cli(self, *lines: str) -> None:
        body = " ".join(f'"{line}"' for line in lines)
        write(self.cli, f"#!/usr/bin/env bash\nprintf '%s\\n' {body}\n", 0o755)

    def run(self, *args: str) -> subprocess.CompletedProcess:
        return run(VERIFY, *args, VIBE_APP=str(self.app), VIBE_CHECKOUT=str(self.checkout),
                   VIBE_PIN=str(self.pin), VIBE_TOOLCHAIN=str(self.tmp / "no-toolchain"))


@pytest.fixture
def bundle(tmp_path: Path) -> Bundle:
    if not PLISTBUDDY.exists():
        pytest.skip("PlistBuddy is macOS-only")
    return Bundle(tmp_path)


def test_verify_accepts_a_good_bundle(bundle: Bundle) -> None:
    before = snapshot(bundle.tmp)
    proc = bundle.run()
    assert proc.returncode == 0, proc.stdout + proc.stderr
    lines = proc.stdout.splitlines()
    assert all(line.startswith("ok: ") for line in lines), proc.stdout
    assert len(lines) >= 5, proc.stdout
    assert "dev.chandra.vibe" in proc.stdout
    assert FAKE_VERSION in proc.stdout and FAKE_COMMIT in proc.stdout
    assert snapshot(bundle.tmp) == before, "verify-package.sh must be read-only"


def test_verify_finds_a_bundle_left_under_the_previous_name(bundle: Bundle) -> None:
    """Renaming the app renames nothing on disk. With no $VIBE_APP the default location
    must also see the tree a previous package.sh wrote, so the checks run on it (and say
    what is stale) instead of reporting that there is no bundle at all."""
    legacy = bundle.tmp / f"VSCode-darwin-{ARCH}" / LEGACY_APP_NAME
    legacy.parent.mkdir(parents=True, exist_ok=True)
    bundle.app.rename(legacy)
    proc = run(VERIFY, VIBE_ROOT=str(bundle.tmp), VIBE_CHECKOUT=str(bundle.checkout),
               VIBE_PIN=str(bundle.pin), VIBE_TOOLCHAIN=str(bundle.tmp / "no-toolchain"))
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert str(legacy) in proc.stdout


def test_verify_refuses_a_missing_bundle(bundle: Bundle) -> None:
    shutil.rmtree(bundle.app)
    proc = bundle.run()
    assert proc.returncode != 0
    assert "package.sh" in proc.stderr and str(bundle.app) in proc.stderr


def test_verify_refuses_a_foreign_identifier(bundle: Bundle) -> None:
    bundle.set_identifier("com.microsoft.VSCode")
    proc = bundle.run()
    assert proc.returncode != 0
    assert "com.microsoft.VSCode" in proc.stderr and "dev.chandra.vibe" in proc.stderr


@pytest.mark.parametrize("key,value", [("nameLong", "Code - OSS"), ("applicationName", "code")])
def test_verify_refuses_unbranded_product_json(bundle: Bundle, key: str, value: str) -> None:
    product = bundle.product()
    product[key] = value
    bundle.set_product(product)
    proc = bundle.run()
    assert proc.returncode != 0
    assert key in proc.stderr and value in proc.stderr


def test_verify_refuses_a_missing_gallery(bundle: Bundle) -> None:
    product = bundle.product()
    del product["extensionsGallery"]
    bundle.set_product(product)
    proc = bundle.run()
    assert proc.returncode != 0
    assert "extensionsGallery" in proc.stderr and "open-vsx.org" in proc.stderr


def test_verify_refuses_the_upstream_gallery(bundle: Bundle) -> None:
    product = bundle.product()
    product["extensionsGallery"] = {"serviceUrl": "https://marketplace.visualstudio.com/_apis/public/gallery"}
    bundle.set_product(product)
    proc = bundle.run()
    assert proc.returncode != 0
    assert "open-vsx.org" in proc.stderr


def test_verify_refuses_a_missing_extension(bundle: Bundle) -> None:
    shutil.rmtree(bundle.ext)
    proc = bundle.run()
    assert proc.returncode != 0
    assert "vibe-chandra" in proc.stderr


def test_verify_refuses_an_unresolvable_extension_main(bundle: Bundle) -> None:
    (bundle.ext / "dist" / "extension.js").unlink()
    proc = bundle.run()
    assert proc.returncode != 0
    assert "main" in proc.stderr and "./dist/extension" in proc.stderr


@pytest.mark.parametrize("asset", ["media/graph.js", "media/graph.css"])
def test_verify_refuses_missing_webview_assets(bundle: Bundle, asset: str) -> None:
    (bundle.ext / asset).unlink()
    proc = bundle.run()
    assert proc.returncode != 0
    assert asset in proc.stderr


def test_verify_refuses_a_missing_cli(bundle: Bundle) -> None:
    bundle.cli.unlink()
    proc = bundle.run()
    assert proc.returncode != 0
    assert "bin" in proc.stderr


def test_verify_refuses_a_stale_cli_version(bundle: Bundle) -> None:
    bundle.set_cli("1.2.3", FAKE_COMMIT, "arm64")
    proc = bundle.run()
    assert proc.returncode != 0
    assert "1.2.3" in proc.stderr and FAKE_VERSION in proc.stderr


def test_verify_refuses_a_commit_that_is_not_the_pin(bundle: Bundle) -> None:
    """product.json `commit` is stamped from the checkout's git HEAD; for a fork
    build that must still be the pinned upstream commit."""
    write(bundle.pin, json.dumps({"repo": "r", "tag": FAKE_VERSION, "commit": "a" * 40,
                                  "node": "1.2.3"}, indent=2))
    proc = bundle.run()
    assert proc.returncode != 0
    assert "a" * 40 in proc.stderr and FAKE_COMMIT in proc.stderr


def test_verify_refuses_a_cli_disagreeing_with_product_json(bundle: Bundle) -> None:
    bundle.set_cli(FAKE_VERSION, "c" * 40, "arm64")
    proc = bundle.run()
    assert proc.returncode != 0
    assert "c" * 40 in proc.stderr


def test_verify_takes_no_arguments(bundle: Bundle) -> None:
    proc = bundle.run("--please")
    assert proc.returncode == 2
    assert "usage" in proc.stderr


# --------------------------------------------------------------------------- the real bundle

BUNDLES = VIBE / f"VSCode-darwin-{ARCH}"
REAL_APP = next((BUNDLES / name for name in (APP_NAME, LEGACY_APP_NAME)
                 if (BUNDLES / name).is_dir()), None)
CHECKOUT_PRODUCT = VIBE / "vscode" / "product.json"


def bundle_predates_product_json() -> bool:
    """A change of identity lands in product.json first: the 1.4 GB tree keeps the name it
    was built with until the next package.sh, and verify-package.sh is right to refuse it
    meanwhile. The files inside a bundle carry the packaging task's fixed 1980 date, so
    its age is the mtime of the `Contents` directory the task wrote."""
    if not CHECKOUT_PRODUCT.is_file():
        return False
    return (REAL_APP / "Contents").stat().st_mtime < CHECKOUT_PRODUCT.stat().st_mtime


@pytest.mark.skipif(REAL_APP is None,
                    reason="no packaged app (vibe/VSCode-* is gitignored; run scripts/package.sh)")
def test_verify_the_real_packaged_app() -> None:
    if bundle_predates_product_json():
        pytest.skip(f"{REAL_APP.name} was packaged before the current "
                    f"{CHECKOUT_PRODUCT.name} — re-run scripts/package.sh")
    proc = run(VERIFY)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "ok: identifier dev.chandra.vibe" in proc.stdout
    version = json.loads((VIBE / "vscode" / "package.json").read_text(encoding="utf-8"))["version"]
    commit = json.loads((VIBE / "upstream.json").read_text(encoding="utf-8"))["commit"]
    assert version in proc.stdout and commit in proc.stdout
