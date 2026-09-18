"""Branding + CLI for Vibe Studio Code.

Three things are checked here, all of them cheap and hermetic:

  * `vibe/bin/vibe` and `vibe/scripts/install-cli.sh` parse (`bash -n`) and
    behave: install / re-install / refuse / --force / --uninstall against a
    throwaway `VIBE_BIN_DIR`, never a real system directory.
  * `vibe --vibe-which` resolves its own location THROUGH a symlink (macOS has
    no `readlink -f`), reports the dev backend of the root it lands in, and
    honours a `$VIBE_APP` override pointed at a fake `.app` bundle. The dev
    cases run against a throwaway root: next to the real checkout a packaged
    bundle may exist, and it legitimately wins over the dev build.
  * `vibe/vscode/product.json` — only when the gitignored upstream checkout is
    present — carries the Vibe identity keys and the Open VSX gallery.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
VIBE = REPO_ROOT / "vibe"
BIN_VIBE = VIBE / "bin" / "vibe"
INSTALL_CLI = VIBE / "scripts" / "install-cli.sh"
PRODUCT_JSON = VIBE / "vscode" / "product.json"

APP_NAME = "Vibe Studio Code.app"


def run(cmd: list[str], env: dict[str, str] | None = None,
        cwd: Path | None = None) -> subprocess.CompletedProcess:
    base = {k: v for k, v in os.environ.items() if k != "VIBE_APP"}
    return subprocess.run(cmd, capture_output=True, text=True, timeout=60,
                          cwd=str(cwd or REPO_ROOT), env={**base, **(env or {})})


def make_fake_app(root: Path) -> Path:
    """A stand-in for a packaged bundle: the darwin gulp task ships the CLI at
    `Contents/Resources/app/bin/code` (a fixed name, not `applicationName`)."""
    app = root / APP_NAME
    cli = app / "Contents" / "Resources" / "app" / "bin" / "code"
    cli.parent.mkdir(parents=True)
    cli.write_text("#!/usr/bin/env bash\necho fake-app-cli \"$@\"\n", encoding="utf-8")
    cli.chmod(0o755)
    return app


def make_dev_root(root: Path) -> Path:
    """A vibe root holding only `bin/vibe` and a stub checkout, so the dev backend is
    the one resolution has to find."""
    (root / "bin").mkdir(parents=True)
    shutil.copy2(BIN_VIBE, root / "bin" / "vibe")
    code = root / "vscode" / "scripts" / "code.sh"
    code.parent.mkdir(parents=True)
    code.write_text('#!/usr/bin/env bash\nprintf "dev-code:%s\\n" "$@"\n', encoding="utf-8")
    code.chmod(0o755)
    return root


# --------------------------------------------------------------------------- #
# scripts exist and parse
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize("script", [BIN_VIBE, INSTALL_CLI], ids=["bin/vibe", "install-cli.sh"])
def test_scripts_exist_and_parse(script: Path) -> None:
    assert script.is_file(), f"{script} missing"
    assert os.access(script, os.X_OK), f"{script} must be executable"
    proc = run(["bash", "-n", str(script)])
    assert proc.returncode == 0, proc.stderr


def test_installer_never_sudo() -> None:
    code = [line for line in INSTALL_CLI.read_text(encoding="utf-8").splitlines()
            if not line.lstrip().startswith("#")]
    assert not [line for line in code if "sudo" in line], \
        "install-cli.sh must never escalate"


# --------------------------------------------------------------------------- #
# vibe --vibe-which
# --------------------------------------------------------------------------- #

def which_fields(proc: subprocess.CompletedProcess) -> dict[str, str]:
    assert proc.returncode == 0, proc.stderr
    out = {}
    for line in proc.stdout.splitlines():
        if ":" in line:
            key, _, value = line.partition(":")
            out[key.strip()] = value.strip()
    return out


def test_which_through_symlink_reports_dev_backend(tmp_path: Path) -> None:
    """Invoked as a symlink from an unrelated directory, `vibe` must still find
    its own checkout — the whole point of the readlink loop."""
    root = make_dev_root(tmp_path / "vibe")
    link_dir = tmp_path / "bin"
    link_dir.mkdir()
    link = link_dir / "vibe"
    link.symlink_to(root / "bin" / "vibe")

    fields = which_fields(run([str(link), "--vibe-which"], cwd=tmp_path))
    assert fields["backend"] == "dev"
    assert fields["checkout"] == str(root / "vscode")
    assert fields["target"] == str(root / "vscode" / "scripts" / "code.sh")


def test_which_through_symlink_chain(tmp_path: Path) -> None:
    root = make_dev_root(tmp_path / "vibe")
    first = tmp_path / "vibe-1"
    second = tmp_path / "vibe-2"
    first.symlink_to(root / "bin" / "vibe")
    second.symlink_to(first)
    fields = which_fields(run([str(second), "--vibe-which"], cwd=tmp_path))
    assert fields["checkout"] == str(root / "vscode")


def test_which_honours_vibe_app_override(tmp_path: Path) -> None:
    app = make_fake_app(tmp_path)
    fields = which_fields(run([str(BIN_VIBE), "--vibe-which"], env={"VIBE_APP": str(app)}))
    assert fields["backend"] == "app"
    assert fields["app"] == str(app)
    assert fields["target"] == str(app / "Contents" / "Resources" / "app" / "bin" / "code")


def test_which_launches_nothing(tmp_path: Path) -> None:
    """--vibe-which must be inert: the fake CLI prints a marker if executed."""
    app = make_fake_app(tmp_path)
    proc = run([str(BIN_VIBE), "--vibe-which"], env={"VIBE_APP": str(app)})
    assert proc.returncode == 0
    assert "fake-app-cli" not in proc.stdout


def test_vibe_app_override_is_execed(tmp_path: Path) -> None:
    app = make_fake_app(tmp_path)
    proc = run([str(BIN_VIBE), "--version"], env={"VIBE_APP": str(app)})
    assert proc.returncode == 0, proc.stderr
    assert "fake-app-cli --version" in proc.stdout


def test_missing_vibe_app_fails_loudly(tmp_path: Path) -> None:
    proc = run([str(BIN_VIBE), "--vibe-which"],
               env={"VIBE_APP": str(tmp_path / "nope.app")})
    assert proc.returncode != 0
    assert "VIBE_APP" in proc.stderr


# --------------------------------------------------------------------------- #
# install-cli.sh
# --------------------------------------------------------------------------- #

def install(bin_dir: Path, *args: str) -> subprocess.CompletedProcess:
    return run(["bash", str(INSTALL_CLI), *args], env={"VIBE_BIN_DIR": str(bin_dir)})


def test_install_creates_symlink(tmp_path: Path) -> None:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    proc = install(bin_dir)
    assert proc.returncode == 0, proc.stderr
    link = bin_dir / "vibe"
    assert link.is_symlink()
    assert Path(os.readlink(link)) == BIN_VIBE
    assert str(link) in proc.stdout
    assert "PATH" in proc.stdout


def test_install_creates_missing_bin_dir(tmp_path: Path) -> None:
    bin_dir = tmp_path / "made" / "up" / "bin"
    assert install(bin_dir).returncode == 0
    assert (bin_dir / "vibe").is_symlink()


def test_install_is_idempotent(tmp_path: Path) -> None:
    bin_dir = tmp_path / "bin"
    assert install(bin_dir).returncode == 0
    second = install(bin_dir)
    assert second.returncode == 0, second.stderr
    assert (bin_dir / "vibe").is_symlink()


def test_install_refuses_regular_file(tmp_path: Path) -> None:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    (bin_dir / "vibe").write_text("i was here first\n", encoding="utf-8")
    proc = install(bin_dir)
    assert proc.returncode != 0
    assert (bin_dir / "vibe").read_text(encoding="utf-8") == "i was here first\n"
    assert "--force" in proc.stderr + proc.stdout


def test_install_refuses_foreign_symlink(tmp_path: Path) -> None:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    other = tmp_path / "somewhere-else"
    other.write_text("#!/bin/sh\n", encoding="utf-8")
    (bin_dir / "vibe").symlink_to(other)
    proc = install(bin_dir)
    assert proc.returncode != 0
    assert Path(os.readlink(bin_dir / "vibe")) == other


def test_force_overwrites(tmp_path: Path) -> None:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    (bin_dir / "vibe").write_text("i was here first\n", encoding="utf-8")
    proc = install(bin_dir, "--force")
    assert proc.returncode == 0, proc.stderr
    assert Path(os.readlink(bin_dir / "vibe")) == BIN_VIBE


def test_uninstall_removes_only_our_symlink(tmp_path: Path) -> None:
    bin_dir = tmp_path / "bin"
    assert install(bin_dir).returncode == 0
    proc = install(bin_dir, "--uninstall")
    assert proc.returncode == 0, proc.stderr
    assert not (bin_dir / "vibe").exists()


def test_uninstall_leaves_foreign_entry_alone(tmp_path: Path) -> None:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    (bin_dir / "vibe").write_text("not ours\n", encoding="utf-8")
    proc = install(bin_dir, "--uninstall")
    assert proc.returncode != 0
    assert (bin_dir / "vibe").read_text(encoding="utf-8") == "not ours\n"


@pytest.mark.skipif(Path(f"/Applications/{APP_NAME}").exists(),
                    reason="a real /Applications bundle would legitimately win")
def test_installed_symlink_resolves_to_our_root(tmp_path: Path) -> None:
    """End to end: install, then run the installed name. Whether the dev build or a
    packaged bundle answers depends on what has been built; the root must be ours."""
    bin_dir = tmp_path / "bin"
    assert install(bin_dir).returncode == 0
    fields = which_fields(run([str(bin_dir / "vibe"), "--vibe-which"], cwd=tmp_path))
    home = fields.get("checkout") or fields.get("app")
    assert home and home.startswith(f"{VIBE}{os.sep}"), fields


# --------------------------------------------------------------------------- #
# product.json identity (skipped when the gitignored checkout is absent)
# --------------------------------------------------------------------------- #

IDENTITY = {
    "nameShort": "Vibe",
    "nameLong": "Vibe Studio Code",
    "applicationName": "vibe",
    "dataFolderName": ".vibe",
    "sharedDataFolderName": ".vibe-shared",
    "serverApplicationName": "vibe-server",
    "serverDataFolderName": ".vibe-server",
    "tunnelApplicationName": "vibe-tunnel",
    "darwinBundleIdentifier": "dev.chandra.vibe",
    "linuxIconName": "vibe",
    "urlProtocol": "vibe",
    "win32MutexName": "vibe",
}


@pytest.fixture(scope="module")
def product() -> dict:
    if not PRODUCT_JSON.is_file():
        pytest.skip("upstream checkout absent (vibe/vscode is gitignored)")
    return json.loads(PRODUCT_JSON.read_text(encoding="utf-8"))


@pytest.mark.parametrize("key,value", sorted(IDENTITY.items()))
def test_product_identity(product: dict, key: str, value: str) -> None:
    assert product.get(key) == value


def test_product_open_vsx_gallery(product: dict) -> None:
    gallery = product.get("extensionsGallery")
    assert gallery == {
        "serviceUrl": "https://open-vsx.org/vscode/gallery",
        "itemUrl": "https://open-vsx.org/vscode/item",
    }


def test_product_win32_names_rebranded(product: dict) -> None:
    for key in ("win32DirName", "win32NameVersion", "win32RegValueName",
                "win32AppUserModelId", "win32ShellNameShort",
                "win32TunnelServiceMutex", "win32TunnelMutex"):
        value = product[key]
        assert "OSS" not in value and "Microsoft" not in value, f"{key} still upstream"
        assert "ib" in value.lower() or "Vibe" in value, f"{key} not rebranded: {value}"
    # the installer GUIDs are deliberately left alone
    assert product["win32x64AppId"].startswith("{{")


def test_product_issue_url_not_upstream(product: dict) -> None:
    assert "microsoft" not in product.get("reportIssueUrl", "").lower()


def test_product_licence_untouched(product: dict) -> None:
    assert product["licenseName"] == "MIT"
    assert product["licenseFileName"] == "LICENSE.txt"


def test_product_json_uses_tabs() -> None:
    if not PRODUCT_JSON.is_file():
        pytest.skip("upstream checkout absent (vibe/vscode is gitignored)")
    for line in PRODUCT_JSON.read_text(encoding="utf-8").splitlines():
        if line.startswith(" "):
            raise AssertionError(f"space-indented line in product.json: {line!r}")


def test_no_stale_oss_identity(product: dict) -> None:
    """A rebrand that misses a key leaves `code-oss` behind in a name string."""
    for key in sorted(IDENTITY) + ["win32DirName", "win32ShellNameShort"]:
        assert "oss" not in str(product[key]).lower(), f"{key} still says OSS"


def test_bundled_cli_name_is_documented() -> None:
    """The darwin gulp task hardcodes `bin/code` inside the bundle; bin/vibe has
    to know that, so keep the knowledge visible in the script."""
    assert "Resources/app/bin" in BIN_VIBE.read_text(encoding="utf-8")


@pytest.mark.skipif(Path(f"/Applications/{APP_NAME}").exists(),
                    reason="a real /Applications bundle would legitimately win")
def test_dev_backend_needs_a_checkout(tmp_path: Path) -> None:
    """With no checkout and no app anywhere, `vibe` must say so rather than
    silently exec'ing something else."""
    fake_vibe = tmp_path / "vibe"
    (fake_vibe / "bin").mkdir(parents=True)
    shutil.copy2(BIN_VIBE, fake_vibe / "bin" / "vibe")
    proc = run([str(fake_vibe / "bin" / "vibe"), "--vibe-which"], cwd=tmp_path)
    assert proc.returncode != 0
    assert "Vibe Studio Code" in proc.stderr
