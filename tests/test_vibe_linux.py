"""The Linux desktop build: ``scripts/package-linux.sh`` and ``scripts/verify-linux.sh``.

Nothing here builds anything or starts a container. ``package-linux.sh`` is exercised
through ``--print-plan`` (the steps it *would* run, for both architectures) and through
its refusals, with a fake ``docker`` first on PATH proving that no work was started.
``verify-linux.sh`` is checked against fake tarballs under ``tmp_path`` - one good tree
with tiny fake ELF headers plus a broken variant per check - and, when it exists, against
the real tarball under ``.build/dist/``.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import struct
import subprocess
import tarfile
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
SCRIPTS = REPO / "scripts"
PACKAGE = SCRIPTS / "package-linux.sh"
VERIFY = SCRIPTS / "verify-linux.sh"
HELPERS = SCRIPTS / "linux"
DIST = REPO / ".build" / "dist"

# macOS ships bash 3.2 at /bin/bash; run the scripts under it so compatibility is tested.
BASH = "/bin/bash" if Path("/bin/bash").exists() else shutil.which("bash")

FAKE_COMMIT = "c" * 40
OTHER_COMMIT = "d" * 40
VERSION = "9.9.9"
NODE_VERSION = "24.1.2"
EM = {"x64": 62, "arm64": 183}
MACHO_ARM64 = bytes.fromhex("cffaedfe0c000001") + b"\0" * 56

GALLERY = {"serviceUrl": "https://open-vsx.org/vscode/gallery", "itemUrl": "https://open-vsx.org/vscode/item"}
EXTENSIONS = ["vibe-chandra", "vibe-agents", "vibe-remote-ssh"]
NATIVES = [
    "resources/app/node_modules.asar.unpacked/node-pty/build/Release/pty.node",
    "resources/app/node_modules.asar.unpacked/@vscode/spdlog/build/Release/spdlog.node",
    "resources/app/node_modules.asar.unpacked/@parcel/watcher/build/Release/watcher.node",
    "resources/app/node_modules.asar.unpacked/@vscode/sqlite3/build/Release/vscode-sqlite3.node",
    "resources/app/node_modules.asar.unpacked/native-keymap/build/Release/keymapping.node",
]


# --------------------------------------------------------------------------- helpers

def write(path: Path, data: str, mode: int = 0o644) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(data, encoding="utf-8")
    path.chmod(mode)


def write_bytes(path: Path, data: bytes, mode: int = 0o644) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    path.chmod(mode)


def fake_elf(arch: str = "x64", glibc: str = "2.17") -> bytes:
    """A 64-bit little-endian ELF header for `arch`, followed by the version name a real
    binary keeps in .dynstr for the newest glibc symbol it needs."""
    ident = b"\x7fELF" + bytes([2, 1, 1, 0]) + b"\0" * 8
    header = ident + struct.pack("<HHI", 3, EM[arch], 1) + b"\0" * 40
    return header + b"\0libc.so.6\0GLIBC_2.2.5\0GLIBC_" + glibc.encode() + b"\0"


def run(script: Path, *args: str, **env: str) -> subprocess.CompletedProcess:
    base = {k: v for k, v in os.environ.items() if not k.startswith("VIBE_") and k != "BUILD_SOURCEVERSION"}
    return subprocess.run([BASH, str(script), *args], cwd=str(REPO), capture_output=True,
                          text=True, timeout=900, env={**base, **env})


def fake_tools(tmp: Path, docker_info_rc: int = 0) -> tuple[str, Path]:
    """A PATH whose `docker` and `npm` only record their arguments, and the record's path.
    `docker info` exits with `docker_info_rc`, which is how a stopped daemon looks."""
    log = tmp / "tools-were-run"
    write(tmp / "fakebin" / "docker",
          f'#!/usr/bin/env bash\necho "docker $*" >> "{log}"\n'
          f'[ "$1" = info ] && exit {docker_info_rc}\nexit 0\n', 0o755)
    write(tmp / "fakebin" / "npm", f'#!/usr/bin/env bash\necho "npm $*" >> "{log}"\n', 0o755)
    return f"{tmp / 'fakebin'}:{os.environ['PATH']}", log


def fake_checkout(tmp: Path, patched: bool = True) -> Path:
    """The few files package-linux.sh reads before it starts any work."""
    checkout = tmp / "vscode"
    write(checkout / "package.json", json.dumps({"version": VERSION}))
    write(checkout / "package-lock.json", json.dumps({"packages": {}}))
    write(checkout / ".npmrc", f'disturl="https://electronjs.org/headers"\ntarget="42.0.0"\nruntime="electron"\n')
    write(checkout / "product.json", json.dumps({"nameLong": "Vibe Slop Code", "applicationName": "vibe"}))
    write(checkout / "node_modules" / ".keep", "")
    seam = "process.env['VIBE_DESKTOP_ROOT']" if patched else "root"
    write(checkout / "build" / "gulpfile.vscode.ts", f"const modulesRoot = {seam};\n")
    write(checkout / ".nvmrc", f"{NODE_VERSION}\n")
    return checkout


def build_env(tmp: Path, **extra: str) -> dict[str, str]:
    return {"VIBE_ROOT": str(tmp), "VIBE_CHECKOUT": str(tmp / "vscode"),
            "VIBE_TOOLCHAIN": str(tmp / "no-toolchain"), "BUILD_SOURCEVERSION": FAKE_COMMIT, **extra}


# --------------------------------------------------------------------------- static

@pytest.mark.parametrize("script", [PACKAGE, VERIFY], ids=["package-linux.sh", "verify-linux.sh"])
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


def test_helper_scripts_parse_and_are_ascii() -> None:
    helper = HELPERS / "npm-ci.sh"
    assert helper.is_file(), f"missing {helper}"
    assert (HELPERS / "Dockerfile").is_file()
    proc = subprocess.run([BASH, "-n", str(helper)], capture_output=True, text=True)
    assert proc.returncode == 0, proc.stderr
    assert "\nset -euo pipefail\n" in helper.read_text(encoding="utf-8")
    for path in [PACKAGE, VERIFY, *sorted(HELPERS.iterdir())]:
        if path.is_file():
            path.read_bytes().decode("ascii")


def test_the_container_carries_what_the_desktop_natives_need() -> None:
    """native-keymap needs the xkbfile/X11 headers and kerberos the krb5 ones - the three
    -dev packages upstream installs for a linux build - and glibc 2.28 comes from the base
    image, which is what pins the ceiling verify-linux.sh enforces."""
    text = (HELPERS / "Dockerfile").read_text(encoding="utf-8")
    assert "almalinux:8" in text
    for package in ("libxkbfile-devel", "libX11-devel", "krb5-devel", "gcc-toolset-13-gcc-c++"):
        assert package in text, f"the image does not install {package}"


def test_readme_documents_the_linux_build() -> None:
    readme = (REPO / "README.md").read_text(encoding="utf-8")
    for needle in ("package-linux.sh", "verify-linux.sh", ".build/dist", "--no-sandbox", "chrome-sandbox"):
        assert needle in readme, f"README does not mention {needle}"


# --------------------------------------------------------------------------- package-linux.sh plan

@pytest.mark.parametrize("args,arch,platform", [
    ([], "x64", "linux/amd64"),
    (["--arch", "x64"], "x64", "linux/amd64"),
    (["--arch", "arm64"], "arm64", "linux/arm64"),
])
def test_print_plan_names_every_step_and_runs_nothing(tmp_path: Path, args: list[str], arch: str,
                                                      platform: str) -> None:
    fake_checkout(tmp_path)
    path, log = fake_tools(tmp_path)
    proc = run(PACKAGE, *args, "--print-plan", PATH=path, **build_env(tmp_path))
    assert proc.returncode == 0, proc.stderr
    plan = proc.stdout
    for needle in (f"--platform {platform}", f"vibe-linux-build:linux-{arch}", "npm-ci.sh", NODE_VERSION,
                   "VIBE_DESKTOP_ROOT=", f"npm run gulp vscode-linux-{arch}\n",
                   f"{tmp_path}/VSCode-linux-{arch}",
                   f"{tmp_path}/.build/dist/VibeSlopCode-linux-{arch}-{VERSION}.tar.gz", ".sha256"):
        assert needle in plan, f"plan lacks {needle!r}:\n{plan}"
    other = "arm64" if arch == "x64" else "x64"
    assert f"linux-{other}" not in plan
    assert not log.exists(), "--print-plan must not run docker or npm"
    assert not (tmp_path / ".build").exists(), "--print-plan must not create anything"


def test_print_plan_mentions_the_verify_step(tmp_path: Path) -> None:
    fake_checkout(tmp_path)
    proc = run(PACKAGE, "--print-plan", **build_env(tmp_path))
    assert proc.returncode == 0, proc.stderr
    assert "verify-linux.sh" in proc.stdout


def test_print_plan_package_only_reuses_the_bundle(tmp_path: Path) -> None:
    fake_checkout(tmp_path)
    proc = run(PACKAGE, "--package-only", "--print-plan", **build_env(tmp_path))
    assert proc.returncode == 0, proc.stderr
    assert "npm run gulp vscode-linux-x64-ci\n" in proc.stdout
    assert "npm run gulp vscode-linux-x64\n" not in proc.stdout, "--package-only must not bundle again"


def test_print_plan_needs_no_checkout(tmp_path: Path) -> None:
    proc = run(PACKAGE, "--print-plan", VIBE_ROOT=str(tmp_path), VIBE_CHECKOUT=str(tmp_path / "none"),
               VIBE_TOOLCHAIN=str(tmp_path / "no-toolchain"))
    assert proc.returncode == 0, proc.stderr
    assert "VibeSlopCode-linux-x64-<version>.tar.gz" in proc.stdout


@pytest.mark.parametrize("args", [["--nope"], ["--arch"], ["--arch", "riscv"], ["extra"]])
def test_bad_arguments_are_rejected(tmp_path: Path, args: list[str]) -> None:
    path, log = fake_tools(tmp_path)
    proc = run(PACKAGE, *args, "--print-plan", PATH=path, **build_env(tmp_path))
    assert proc.returncode == 2, proc.stdout
    assert "usage" in proc.stderr
    assert not log.exists()


# --------------------------------------------------------------------------- package-linux.sh refusals

def test_refuses_a_stopped_docker_daemon(tmp_path: Path) -> None:
    fake_checkout(tmp_path)
    path, log = fake_tools(tmp_path, docker_info_rc=1)
    proc = run(PACKAGE, PATH=path, **build_env(tmp_path))
    assert proc.returncode != 0
    assert "Docker" in proc.stderr and "not running" in proc.stderr
    assert log.read_text(encoding="utf-8").splitlines() == ["docker info"], "nothing but the probe may run"
    assert not (tmp_path / ".build").exists()


def test_refuses_without_docker_on_path(tmp_path: Path) -> None:
    fake_checkout(tmp_path)
    fakebin = tmp_path / "fakebin"
    fakebin.mkdir()
    # grep and shasum are there on purpose: without them the script would refuse for the
    # wrong reason and the check below would pass without ever reaching the docker one.
    for tool in ("bash", "dirname", "sed", "grep", "shasum", "git", "python3", "uname", "env"):
        found = shutil.which(tool)
        if found:
            (fakebin / tool).symlink_to(found)
    proc = run(PACKAGE, PATH=str(fakebin), **build_env(tmp_path))
    assert proc.returncode != 0
    assert "docker is not on PATH" in proc.stderr


def test_refuses_a_missing_checkout(tmp_path: Path) -> None:
    path, log = fake_tools(tmp_path)
    proc = run(PACKAGE, PATH=path, **build_env(tmp_path))
    assert proc.returncode != 0
    assert str(tmp_path / "vscode") in proc.stderr and "bootstrap.sh" in proc.stderr
    assert not log.exists()


def test_refuses_an_unpatched_gulpfile(tmp_path: Path) -> None:
    """Without the patch gulp would silently pack the host's (darwin) node_modules."""
    fake_checkout(tmp_path, patched=False)
    path, log = fake_tools(tmp_path)
    proc = run(PACKAGE, PATH=path, **build_env(tmp_path))
    assert proc.returncode != 0
    assert "VIBE_DESKTOP_ROOT" in proc.stderr and "gulpfile.vscode.ts" in proc.stderr
    assert not log.exists()


# --------------------------------------------------------------------------- verify-linux.sh

class App:
    """A fake packaged tree and the tarball made from it."""

    def __init__(self, tmp: Path, arch: str = "x64", version: str = VERSION):
        self.tmp = tmp
        self.arch = arch
        self.version = version
        self.top = f"VibeSlopCode-linux-{arch}-{version}"
        self.root = tmp / "tree" / self.top
        self.extra_top: list[str] = []
        write_bytes(self.root / "vibe", fake_elf(arch, "2.28"), 0o755)
        write(self.root / "bin" / "vibe", '#!/usr/bin/env bash\nexec "$(dirname "$0")/../vibe" "$@"\n', 0o755)
        write_bytes(self.root / "chrome-sandbox", fake_elf(arch, "2.17"), 0o755)
        self.set_product()
        write(self.root / "resources" / "app" / "package.json", json.dumps({"name": "Vibe", "version": version}))
        write(self.root / "resources" / "app" / "node_modules.asar", "not really an asar\n")
        for native in NATIVES:
            write_bytes(self.root / native, fake_elf(arch))
        for name in EXTENSIONS:
            self.add_extension(name)

    def add_extension(self, name: str) -> None:
        folder = self.root / "resources" / "app" / "extensions" / name
        write(folder / "package.json", json.dumps({"name": name, "main": "./dist/extension"}))
        write(folder / "dist" / "extension.js", "// bundled\n")
        if name != "vibe-remote-ssh":
            write(folder / "media" / "webview.css", "/* */\n")

    def set_product(self, **changes: object) -> None:
        product = {"nameShort": "Vibe", "nameLong": "Vibe Slop Code", "applicationName": "vibe",
                   "dataFolderName": ".vibe", "commit": FAKE_COMMIT, "version": self.version,
                   "extensionsGallery": GALLERY, **changes}
        write(self.root / "resources" / "app" / "product.json", json.dumps(product, indent=2))

    def pack(self, sidecar: bool = True, name: str = "") -> Path:
        tarball = self.tmp / (name or f"VibeSlopCode-linux-{self.arch}-{self.version}.tar.gz")
        with tarfile.open(tarball, "w:gz") as tar:
            tar.add(self.root, arcname=self.top)
            for extra in self.extra_top:
                tar.add(self.tmp / "tree" / extra, arcname=extra)
        if sidecar:
            digest = hashlib.sha256(tarball.read_bytes()).hexdigest()
            write(Path(f"{tarball}.sha256"), f"{digest}  {tarball.name}\n")
        return tarball

    def verify(self, *args: str, **env: str) -> subprocess.CompletedProcess:
        return run(VERIFY, str(self.pack()), *args, VIBE_ROOT=str(self.tmp),
                   VIBE_TOOLCHAIN=str(self.tmp / "no-toolchain"), VIBE_PIN=str(self.pin()), **env)

    def pin(self) -> Path:
        path = self.tmp / "upstream.json"
        if not path.exists():
            write(path, json.dumps({"tag": "1.0.0", "commit": FAKE_COMMIT, "node": NODE_VERSION}, indent=2))
        return path


@pytest.fixture
def app(tmp_path: Path) -> App:
    return App(tmp_path)


@pytest.mark.parametrize("arch", ["x64", "arm64"])
def test_verify_accepts_a_good_tarball(tmp_path: Path, arch: str) -> None:
    proc = App(tmp_path, arch).verify()
    assert proc.returncode == 0, proc.stdout + proc.stderr
    lines = proc.stdout.splitlines()
    assert all(line.startswith("ok: ") or line.startswith("note: ") for line in lines), proc.stdout
    assert len(lines) >= 8, proc.stdout
    for needle in (FAKE_COMMIT, "Vibe Slop Code", "open-vsx.org", "2.28", "sha256", *EXTENSIONS):
        assert needle in proc.stdout, f"no {needle!r} in:\n{proc.stdout}"


def test_verify_leaves_nothing_behind(app: App, tmp_path: Path) -> None:
    scratch = tmp_path / "scratch"
    scratch.mkdir()
    proc = app.verify(TMPDIR=str(scratch))
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert list(scratch.iterdir()) == [], "the unpacked copy must be removed on exit"


def test_verify_needs_a_tarball(tmp_path: Path) -> None:
    proc = run(VERIFY, VIBE_ROOT=str(tmp_path), VIBE_TOOLCHAIN=str(tmp_path / "no-toolchain"))
    assert proc.returncode == 2
    assert "usage" in proc.stderr


def test_verify_refuses_a_tarball_that_is_not_there(tmp_path: Path) -> None:
    proc = run(VERIFY, str(tmp_path / "nope.tar.gz"), VIBE_ROOT=str(tmp_path),
               VIBE_TOOLCHAIN=str(tmp_path / "no-toolchain"))
    assert proc.returncode != 0
    assert "package-linux.sh" in proc.stderr


def test_verify_refuses_a_name_it_cannot_read_the_arch_from(app: App) -> None:
    tarball = app.pack(name="something-else.tar.gz")
    proc = run(VERIFY, str(tarball), VIBE_ROOT=str(app.tmp), VIBE_TOOLCHAIN=str(app.tmp / "no-toolchain"))
    assert proc.returncode != 0
    assert "VibeSlopCode-linux-<arch>-<version>.tar.gz" in proc.stderr


def test_verify_refuses_a_broken_sidecar(app: App) -> None:
    tarball = app.pack()
    write(Path(f"{tarball}.sha256"), f"{'0' * 64}  {tarball.name}\n")
    proc = run(VERIFY, str(tarball), VIBE_ROOT=str(app.tmp), VIBE_TOOLCHAIN=str(app.tmp / "no-toolchain"),
               VIBE_PIN=str(app.pin()))
    assert proc.returncode != 0
    assert "sha256" in proc.stderr


def test_verify_refuses_two_top_level_entries(app: App) -> None:
    write(app.tmp / "tree" / "README.md", "loose\n")
    app.extra_top.append("README.md")
    proc = app.verify()
    assert proc.returncode != 0
    assert "one top-level directory" in proc.stderr


def test_verify_refuses_a_missing_launcher(app: App) -> None:
    (app.root / "bin" / "vibe").unlink()
    proc = app.verify()
    assert proc.returncode != 0
    assert "bin/vibe" in proc.stderr


def test_verify_refuses_a_missing_main_binary(app: App) -> None:
    (app.root / "vibe").unlink()
    proc = app.verify()
    assert proc.returncode != 0
    assert "vibe" in proc.stderr


@pytest.mark.parametrize("path", ["vibe", NATIVES[0]])
def test_verify_refuses_a_binary_of_the_wrong_machine(app: App, path: str) -> None:
    write_bytes(app.root / path, fake_elf("arm64"), 0o755)
    proc = app.verify()
    assert proc.returncode != 0
    assert "x86_64" in proc.stderr and path.split("/")[-1] in proc.stderr


def test_verify_refuses_a_macho_native(app: App) -> None:
    write_bytes(app.root / NATIVES[0], MACHO_ARM64)
    proc = app.verify()
    assert proc.returncode != 0
    assert "Mach-O" in proc.stderr and NATIVES[0] in proc.stderr


def test_verify_refuses_a_macho_file_of_any_name(app: App) -> None:
    helper = "resources/app/node_modules.asar.unpacked/node-pty/build/Release/spawn-helper"
    write_bytes(app.root / helper, MACHO_ARM64, 0o755)
    proc = app.verify()
    assert proc.returncode != 0
    assert "Mach-O" in proc.stderr and helper in proc.stderr


def test_verify_refuses_a_native_that_needs_a_newer_glibc(app: App) -> None:
    write_bytes(app.root / NATIVES[1], fake_elf("x64", "2.34"))
    proc = app.verify()
    assert proc.returncode != 0
    assert "2.34" in proc.stderr and "2.28" in proc.stderr and NATIVES[1] in proc.stderr


def test_verify_takes_the_glibc_ceiling_from_the_environment(app: App) -> None:
    write_bytes(app.root / NATIVES[1], fake_elf("x64", "2.34"))
    proc = app.verify(VIBE_LINUX_MAX_GLIBC="2.34")
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "2.34" in proc.stdout


@pytest.mark.parametrize("key,value", [("nameLong", "Code - OSS"), ("applicationName", "code")])
def test_verify_refuses_unbranded_product_json(app: App, key: str, value: str) -> None:
    app.set_product(**{key: value})
    proc = app.verify()
    assert proc.returncode != 0
    assert key in proc.stderr and value in proc.stderr


def test_verify_refuses_the_microsoft_gallery(app: App) -> None:
    app.set_product(extensionsGallery={"serviceUrl": "https://marketplace.visualstudio.com/_apis/public/gallery",
                                       "itemUrl": "https://marketplace.visualstudio.com/items"})
    proc = app.verify()
    assert proc.returncode != 0
    assert "open-vsx.org" in proc.stderr


def test_verify_refuses_a_commit_that_is_not_the_pin(app: App) -> None:
    app.set_product(commit=OTHER_COMMIT)
    proc = app.verify()
    assert proc.returncode != 0
    assert OTHER_COMMIT in proc.stderr and FAKE_COMMIT in proc.stderr


@pytest.mark.parametrize("name", EXTENSIONS)
def test_verify_refuses_a_missing_built_in_extension(app: App, name: str) -> None:
    shutil.rmtree(app.root / "resources" / "app" / "extensions" / name)
    proc = app.verify()
    assert proc.returncode != 0
    assert name in proc.stderr


@pytest.mark.parametrize("name", EXTENSIONS)
def test_verify_refuses_an_extension_that_was_never_bundled(app: App, name: str) -> None:
    """A source copy without dist/ is what an extension looks like when its build step was
    skipped: present, declared, and dead on first activation."""
    shutil.rmtree(app.root / "resources" / "app" / "extensions" / name / "dist")
    proc = app.verify()
    assert proc.returncode != 0
    assert name in proc.stderr and "dist" in proc.stderr


def test_verify_refuses_an_extension_without_its_media(app: App) -> None:
    shutil.rmtree(app.root / "resources" / "app" / "extensions" / "vibe-chandra" / "media")
    proc = app.verify()
    assert proc.returncode != 0
    assert "vibe-chandra" in proc.stderr and "media" in proc.stderr


# --------------------------------------------------------------------------- the real tarball

def real_tarballs() -> list[Path]:
    return sorted(DIST.glob("VibeSlopCode-linux-*.tar.gz")) if DIST.is_dir() else []


@pytest.mark.skipif(not real_tarballs(), reason="no linux tarball in .build/dist - run scripts/package-linux.sh")
def test_verify_accepts_the_real_tarball() -> None:
    tarball = real_tarballs()[-1]
    proc = run(VERIFY, str(tarball))
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert all(line.startswith("ok: ") or line.startswith("note: ") for line in proc.stdout.splitlines()), proc.stdout
