"""The remote server: ``scripts/build-server.sh`` and ``scripts/verify-server.sh``.

Nothing here builds anything or talks to a host. ``build-server.sh`` is exercised
through ``--print-plan`` (the steps it *would* run, for both architectures) and through
its refusals, with fake ``docker`` and ``npm`` first on PATH proving that no work was
started. ``verify-server.sh`` is checked against fake tarballs under ``tmp_path`` - one
good tree with tiny fake ELF headers plus a broken variant per check - and, when it
exists, against the real tarball under ``.build/server/`` (local checks only; the
``--host`` checks need a real machine and are run by hand).
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
BUILD = SCRIPTS / "build-server.sh"
VERIFY = SCRIPTS / "verify-server.sh"
HELPERS = SCRIPTS / "server"

# macOS ships bash 3.2 at /bin/bash; run the scripts under it so compatibility is tested.
BASH = "/bin/bash" if Path("/bin/bash").exists() else shutil.which("bash")

FAKE_COMMIT = "c" * 40
OTHER_COMMIT = "d" * 40
NODE_VERSION = "24.1.2"
EM = {"x64": 62, "arm64": 183}
MACHO_ARM64 = bytes.fromhex("cffaedfe0c000001") + b"\0" * 56

NATIVES = [
    "node_modules/node-pty/build/Release/pty.node",
    "node_modules/@vscode/spdlog/build/Release/spdlog.node",
    "node_modules/@parcel/watcher/build/Release/watcher.node",
    "node_modules/@vscode/native-watchdog/build/Release/watchdog.node",
    "node_modules/@vscode/sqlite3/build/Release/vscode-sqlite3.node",
    "node_modules/kerberos/build/Release/kerberos.node",
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
                          text=True, timeout=600, env={**base, **env})


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
    """The few files build-server.sh reads before it starts any work."""
    checkout = tmp / "vscode"
    write(checkout / "package.json", json.dumps({"version": "9.9.9"}))
    write(checkout / "remote" / "package.json", json.dumps({"name": "vscode-reh"}))
    write(checkout / "remote" / "package-lock.json", json.dumps({"packages": {}}))
    write(checkout / "remote" / ".npmrc", f'disturl="https://nodejs.org/dist"\ntarget="{NODE_VERSION}"\nruntime="node"\n')
    write(checkout / "node_modules" / ".keep", "")
    remote = "process.env['VIBE_REH_REMOTE']" if patched else "path.join(REPO_ROOT, 'remote')"
    write(checkout / "build" / "gulpfile.reh.ts", f"const REMOTE_FOLDER = {remote};\n")
    return checkout


def build_env(tmp: Path, **extra: str) -> dict[str, str]:
    return {"VIBE_ROOT": str(tmp), "VIBE_CHECKOUT": str(tmp / "vscode"),
            "VIBE_TOOLCHAIN": str(tmp / "no-toolchain"), "BUILD_SOURCEVERSION": FAKE_COMMIT, **extra}


def fake_tarball(tmp: Path, arch: str = "x64") -> Path:
    """What a finished build leaves in .build/server; the contents do not matter here."""
    tarball = tmp / ".build" / "server" / f"vibe-server-linux-{arch}-{FAKE_COMMIT}.tar.gz"
    write(tarball, "a tarball\n")
    write(Path(f"{tarball}.sha256"), f"{'0' * 64}  {tarball.name}\n")
    return tarball


def link_only(tmp: Path, servers: Path) -> subprocess.CompletedProcess:
    path, log = fake_tools(tmp)
    proc = run(BUILD, "--link-only", PATH=path, **build_env(tmp, VIBE_SERVERS_DIR=str(servers)))
    assert not log.exists(), "--link-only must not run docker or npm"
    return proc


# --------------------------------------------------------------------------- static

@pytest.mark.parametrize("script", [BUILD, VERIFY], ids=["build-server.sh", "verify-server.sh"])
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


@pytest.mark.parametrize("name", ["npm-ci.sh", "host-check.sh"])
def test_helper_scripts_parse(name: str) -> None:
    helper = HELPERS / name
    assert helper.is_file(), f"missing {helper}"
    proc = subprocess.run([BASH, "-n", str(helper)], capture_output=True, text=True)
    assert proc.returncode == 0, proc.stderr
    assert "\nset -euo pipefail\n" in helper.read_text(encoding="utf-8")


def test_host_check_never_lets_the_server_fall_back_to_the_home_folder() -> None:
    """The server creates its data folder as soon as its code is loaded - `--version` does
    that too - and defaults to ~/.vibe-server. A first version of the host check ran
    `--version` bare and left that folder on the host it was only visiting."""
    text = (HELPERS / "host-check.sh").read_text(encoding="utf-8")
    assert '\nexport VSCODE_AGENT_FOLDER="$DATA"\n' in text
    invocations = [line for line in text.replace("\\\n", " ").splitlines()
                   if '"$SERVER/bin/vibe-server"' in line and not line.lstrip().startswith("#")]
    assert len(invocations) >= 2, invocations
    for line in invocations:
        assert '--server-data-dir "$DATA"' in line, f"bare server invocation: {line.strip()}"
    assert text.index("export VSCODE_AGENT_FOLDER") < text.index('"$SERVER/bin/vibe-server"')
    assert "HOME_DATA_BEFORE" in text and "was touched by this check" in text


def test_helper_files_exist_and_are_ascii() -> None:
    for path in [BUILD, VERIFY, *sorted(HELPERS.iterdir())]:
        if path.is_file():
            path.read_bytes().decode("ascii")
    assert (HELPERS / "Dockerfile").is_file()
    assert (HELPERS / "natives.py").is_file()


def test_readme_documents_the_remote_server() -> None:
    readme = (REPO / "README.md").read_text(encoding="utf-8")
    for needle in ("## Remote server", "build-server.sh", "verify-server.sh", ".build/server", "--host"):
        assert needle in readme, f"README does not mention {needle}"


def test_readme_documents_connecting_to_a_host() -> None:
    readme = (REPO / "README.md").read_text(encoding="utf-8")
    for needle in ("## Connect to an SSH host", "~/.ssh/config", "~/.vibe-server",
                   "workbench.action.workspaceBar.connectToSshHost", "~/.vscode-server", "linux-x64"):
        assert needle in readme, f"README does not mention {needle}"


# --------------------------------------------------------------------------- build-server.sh plan

@pytest.mark.parametrize("args,arch,platform", [
    ([], "x64", "linux/amd64"),
    (["--arch", "x64"], "x64", "linux/amd64"),
    (["--arch", "arm64"], "arm64", "linux/arm64"),
])
def test_print_plan_names_every_step_and_runs_nothing(tmp_path: Path, args: list[str], arch: str,
                                                      platform: str) -> None:
    fake_checkout(tmp_path)
    path, log = fake_tools(tmp_path)
    proc = run(BUILD, *args, "--print-plan", PATH=path, **build_env(tmp_path))
    assert proc.returncode == 0, proc.stderr
    plan = proc.stdout
    for needle in (f"--platform {platform}", f"vibe-server-build:linux-{arch}", "npm-ci.sh", NODE_VERSION,
                   "compile-non-native-extensions-build", "compile-copilot-extension-build",
                   "compile-extension-media-build",
                   "build/next/index.ts bundle --nls --target server --out out-vscode-reh\n",
                   "VIBE_REH_REMOTE=", f"npm run gulp vscode-reh-linux-{arch}-ci\n",
                   f"{tmp_path}/vscode-reh-linux-{arch}",
                   f"{tmp_path}/.build/server/vibe-server-linux-{arch}-{FAKE_COMMIT}.tar.gz", ".sha256"):
        assert needle in plan, f"plan lacks {needle!r}:\n{plan}"
    other = "arm64" if arch == "x64" else "x64"
    assert f"linux-{other}" not in plan
    assert not log.exists(), "--print-plan must not run docker or npm"
    assert not (tmp_path / ".build").exists(), "--print-plan must not create anything"


def test_plan_never_runs_upstreams_legacy_compile(tmp_path: Path) -> None:
    """At this pin upstream packages through the esbuild bundler (build/next). The top-level
    task `vscode-reh-linux-<arch>` still starts the legacy mangling compile, which no longer
    compiles (41 errors after 20 minutes): only `-build` and `-ci` tasks may be named."""
    fake_checkout(tmp_path)
    proc = run(BUILD, "--print-plan", **build_env(tmp_path))
    assert proc.returncode == 0, proc.stderr
    tasks = re.findall(r"npm run gulp ([^\n]+)", proc.stdout)
    assert tasks, proc.stdout
    for task in " ".join(tasks).split():
        assert task.endswith(("-build", "-ci")), f"plan runs the gulp task {task!r}:\n{proc.stdout}"
    assert "mangling" not in proc.stdout


def test_print_plan_package_only_reuses_the_bundle(tmp_path: Path) -> None:
    fake_checkout(tmp_path)
    proc = run(BUILD, "--package-only", "--print-plan", **build_env(tmp_path))
    assert proc.returncode == 0, proc.stderr
    assert "npm run gulp vscode-reh-linux-x64-ci\n" in proc.stdout
    assert "build/next/index.ts" not in proc.stdout, "--package-only must not bundle again"
    assert "extensions-build" not in proc.stdout, "--package-only must not rebuild the extensions"


def test_print_plan_needs_no_checkout(tmp_path: Path) -> None:
    proc = run(BUILD, "--print-plan", VIBE_ROOT=str(tmp_path), VIBE_CHECKOUT=str(tmp_path / "none"),
               VIBE_TOOLCHAIN=str(tmp_path / "no-toolchain"))
    assert proc.returncode == 0, proc.stderr
    assert "vibe-server-linux-x64-<commit>.tar.gz" in proc.stdout


def test_print_plan_mentions_the_link_step(tmp_path: Path) -> None:
    servers = tmp_path / "servers"
    proc = run(BUILD, "--print-plan", **build_env(tmp_path, VIBE_SERVERS_DIR=str(servers)))
    assert proc.returncode == 0, proc.stderr
    assert "link" in proc.stdout and str(servers) in proc.stdout, proc.stdout
    assert not servers.exists(), "--print-plan must not create anything"


def test_print_plan_without_linking_omits_the_link_step(tmp_path: Path) -> None:
    servers = tmp_path / "servers"
    proc = run(BUILD, "--no-link", "--print-plan", **build_env(tmp_path, VIBE_SERVERS_DIR=str(servers)))
    assert proc.returncode == 0, proc.stderr
    assert str(servers) not in proc.stdout, proc.stdout


@pytest.mark.parametrize("args", [["--nope"], ["--arch"], ["--arch", "riscv"], ["extra"],
                                  ["--link-only", "--no-link"]])
def test_bad_arguments_are_rejected(tmp_path: Path, args: list[str]) -> None:
    path, log = fake_tools(tmp_path)
    proc = run(BUILD, *args, "--print-plan", PATH=path, **build_env(tmp_path))
    assert proc.returncode == 2, proc.stdout
    assert "usage" in proc.stderr
    assert not log.exists()


# --------------------------------------------------------------------------- build-server.sh --link-only

def test_link_only_links_the_tarball_where_an_installed_app_looks(tmp_path: Path) -> None:
    """An app outside the build tree - one copied to /Applications - searches only
    ~/.vibe/servers, so the build has to leave the tarball there too."""
    tarball = fake_tarball(tmp_path)
    servers = tmp_path / "servers"
    proc = link_only(tmp_path, servers)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    for source in (tarball, Path(f"{tarball}.sha256")):
        link = servers / source.name
        assert link.is_symlink(), proc.stdout
        assert Path(os.readlink(link)) == source
        assert str(link) in proc.stdout


def test_link_only_refuses_a_tarball_that_was_never_built(tmp_path: Path) -> None:
    servers = tmp_path / "servers"
    proc = link_only(tmp_path, servers)
    assert proc.returncode != 0
    assert f"vibe-server-linux-x64-{FAKE_COMMIT}.tar.gz" in proc.stderr
    assert not servers.exists(), "nothing is created for a build that does not exist"


def test_link_only_is_idempotent(tmp_path: Path) -> None:
    tarball = fake_tarball(tmp_path)
    servers = tmp_path / "servers"
    assert link_only(tmp_path, servers).returncode == 0
    second = link_only(tmp_path, servers)
    assert second.returncode == 0, second.stdout + second.stderr
    assert Path(os.readlink(servers / tarball.name)) == tarball


def test_link_only_replaces_a_dangling_link(tmp_path: Path) -> None:
    """Every build removes the tarball of the one before it, so its link is ours to reuse."""
    tarball = fake_tarball(tmp_path)
    servers = tmp_path / "servers"
    servers.mkdir()
    (servers / tarball.name).symlink_to(tmp_path / ".build" / "server" / "gone.tar.gz")
    proc = link_only(tmp_path, servers)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert Path(os.readlink(servers / tarball.name)) == tarball


def test_link_only_never_overwrites_a_regular_file(tmp_path: Path) -> None:
    tarball = fake_tarball(tmp_path)
    servers = tmp_path / "servers"
    servers.mkdir()
    (servers / tarball.name).write_text("someone else's build\n", encoding="utf-8")
    proc = link_only(tmp_path, servers)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert (servers / tarball.name).read_text(encoding="utf-8") == "someone else's build\n"
    assert str(servers / tarball.name) in proc.stderr
    assert (servers / f"{tarball.name}.sha256").is_symlink(), "the sidecar is still linked"


def test_link_only_leaves_a_link_of_someone_else_alone(tmp_path: Path) -> None:
    tarball = fake_tarball(tmp_path)
    servers = tmp_path / "servers"
    servers.mkdir()
    other = tmp_path / "elsewhere" / tarball.name
    write(other, "another build\n")
    (servers / tarball.name).symlink_to(other)
    proc = link_only(tmp_path, servers)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert Path(os.readlink(servers / tarball.name)) == other
    assert str(servers / tarball.name) in proc.stderr


# --------------------------------------------------------------------------- build-server.sh refusals

def test_refuses_when_docker_is_not_running(tmp_path: Path) -> None:
    fake_checkout(tmp_path)
    path, log = fake_tools(tmp_path, docker_info_rc=1)
    proc = run(BUILD, PATH=path, **build_env(tmp_path))
    assert proc.returncode != 0
    assert "Docker" in proc.stderr and "not running" in proc.stderr
    assert log.read_text(encoding="utf-8").splitlines() == ["docker info"], "nothing but the probe may run"
    assert not (tmp_path / ".build").exists()


def test_refuses_without_docker_on_path(tmp_path: Path) -> None:
    fake_checkout(tmp_path)
    fakebin = tmp_path / "fakebin"
    fakebin.mkdir()
    for tool in ("bash", "dirname", "sed", "git", "python3", "uname", "env"):
        found = shutil.which(tool)
        if found:
            (fakebin / tool).symlink_to(found)
    proc = run(BUILD, PATH=str(fakebin), **build_env(tmp_path))
    assert proc.returncode != 0
    assert "docker" in proc.stderr.lower()


def test_refuses_a_missing_checkout(tmp_path: Path) -> None:
    path, log = fake_tools(tmp_path)
    proc = run(BUILD, PATH=path, **build_env(tmp_path))
    assert proc.returncode != 0
    assert str(tmp_path / "vscode") in proc.stderr and "bootstrap.sh" in proc.stderr
    assert not log.exists()


def test_refuses_an_unpatched_gulpfile(tmp_path: Path) -> None:
    """Without the patch gulp would silently pack the host's (darwin) node_modules."""
    fake_checkout(tmp_path, patched=False)
    path, log = fake_tools(tmp_path)
    proc = run(BUILD, PATH=path, **build_env(tmp_path))
    assert proc.returncode != 0
    assert "VIBE_REH_REMOTE" in proc.stderr and "gulpfile.reh.ts" in proc.stderr
    assert not log.exists()


def test_refuses_a_commit_the_packaged_client_does_not_carry(tmp_path: Path) -> None:
    fake_checkout(tmp_path)
    app = tmp_path / "VSCode-darwin-arm64" / "Vibe Slop Code.app"
    write(app / "Contents" / "Resources" / "app" / "product.json", json.dumps({"commit": OTHER_COMMIT}))
    path, log = fake_tools(tmp_path)
    proc = run(BUILD, PATH=path, **build_env(tmp_path))
    assert proc.returncode != 0
    assert FAKE_COMMIT in proc.stderr and OTHER_COMMIT in proc.stderr
    assert not log.exists()


# --------------------------------------------------------------------------- verify-server.sh

class Server:
    """A fake server tree and the tarball made from it."""

    def __init__(self, tmp: Path, arch: str = "x64"):
        self.tmp = tmp
        self.arch = arch
        self.top = f"vscode-reh-linux-{arch}"
        self.root = tmp / "tree" / self.top
        self.extra_top: list[str] = []
        write(self.root / "bin" / "vibe-server", '#!/usr/bin/env sh\nexec "$(dirname "$0")/../node" "$@"\n', 0o755)
        write_bytes(self.root / "node", fake_elf(arch, "2.28"), 0o755)
        self.set_product(commit=FAKE_COMMIT)
        write(self.root / "out" / "server-main.js", "// bundled\n")
        for native in NATIVES:
            write_bytes(self.root / native, fake_elf(arch))
        write_bytes(self.root / "node_modules" / "@vscode" / "ripgrep-universal" / "bin" / f"linux-{arch}" / "rg",
                    fake_elf(arch), 0o755)
        write(self.root / "extensions" / "vibe-chandra" / "package.json", json.dumps({"name": "vibe-chandra"}))

    def set_product(self, **changes: str) -> None:
        product = {"nameShort": "Vibe", "applicationName": "vibe", "serverApplicationName": "vibe-server",
                   "serverDataFolderName": ".vibe-server", "version": "9.9.9", **changes}
        write(self.root / "product.json", json.dumps(product, indent=2))

    def pack(self, commit: str = FAKE_COMMIT, sidecar: bool = True) -> Path:
        tarball = self.tmp / f"vibe-server-linux-{self.arch}-{commit}.tar.gz"
        with tarfile.open(tarball, "w:gz") as tar:
            tar.add(self.root, arcname=self.top)
            for name in self.extra_top:
                tar.add(self.tmp / "tree" / name, arcname=name)
        if sidecar:
            digest = hashlib.sha256(tarball.read_bytes()).hexdigest()
            write(Path(f"{tarball}.sha256"), f"{digest}  {tarball.name}\n")
        return tarball

    def verify(self, *args: str, **env: str) -> subprocess.CompletedProcess:
        tarball = self.pack()
        return run(VERIFY, str(tarball), *args, VIBE_ROOT=str(self.tmp),
                   VIBE_TOOLCHAIN=str(self.tmp / "no-toolchain"), **env)


@pytest.fixture
def server(tmp_path: Path) -> Server:
    return Server(tmp_path)


@pytest.mark.parametrize("arch", ["x64", "arm64"])
def test_verify_accepts_a_good_tarball(tmp_path: Path, arch: str) -> None:
    proc = Server(tmp_path, arch).verify()
    assert proc.returncode == 0, proc.stdout + proc.stderr
    lines = proc.stdout.splitlines()
    assert all(line.startswith("ok: ") for line in lines), proc.stdout
    assert len(lines) >= 7, proc.stdout
    for needle in (FAKE_COMMIT, "vibe-server", ".vibe-server", "2.28", "vibe-chandra", "sha256"):
        assert needle in proc.stdout, f"no {needle!r} in:\n{proc.stdout}"


def test_verify_leaves_nothing_behind(server: Server, tmp_path: Path) -> None:
    scratch = tmp_path / "scratch"
    scratch.mkdir()
    proc = server.verify(TMPDIR=str(scratch))
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert list(scratch.iterdir()) == [], "the unpacked copy must be removed on exit"


def test_verify_refuses_a_macho_native(server: Server) -> None:
    write_bytes(server.root / NATIVES[0], MACHO_ARM64)
    proc = server.verify()
    assert proc.returncode != 0
    assert "Mach-O" in proc.stderr and NATIVES[0] in proc.stderr


def test_verify_refuses_a_macho_file_of_any_name(server: Server) -> None:
    helper = "node_modules/node-pty/build/Release/spawn-helper"
    write_bytes(server.root / helper, MACHO_ARM64, 0o755)
    proc = server.verify()
    assert proc.returncode != 0
    assert "Mach-O" in proc.stderr and helper in proc.stderr


def test_verify_refuses_a_native_of_another_architecture(server: Server) -> None:
    write_bytes(server.root / NATIVES[1], fake_elf("arm64"))
    proc = server.verify()
    assert proc.returncode != 0
    assert NATIVES[1] in proc.stderr and "aarch64" in proc.stderr and "x86_64" in proc.stderr


def test_verify_refuses_a_missing_native(server: Server) -> None:
    (server.root / NATIVES[2]).unlink()
    proc = server.verify()
    assert proc.returncode != 0
    assert NATIVES[2] in proc.stderr


def test_verify_refuses_the_wrong_commit(server: Server) -> None:
    server.set_product(commit=OTHER_COMMIT)
    proc = server.verify()
    assert proc.returncode != 0
    assert "commit" in proc.stderr and OTHER_COMMIT in proc.stderr and FAKE_COMMIT in proc.stderr


def test_verify_refuses_a_commit_the_packaged_client_does_not_carry(server: Server, tmp_path: Path) -> None:
    app = tmp_path / "Vibe Slop Code.app"
    write(app / "Contents" / "Resources" / "app" / "product.json", json.dumps({"commit": OTHER_COMMIT}))
    proc = server.verify(VIBE_APP=str(app))
    assert proc.returncode != 0
    assert "client" in proc.stderr and OTHER_COMMIT in proc.stderr


@pytest.mark.parametrize("key,value", [("serverApplicationName", "code-server-oss"),
                                       ("serverDataFolderName", ".vscode-server-oss")])
def test_verify_refuses_unbranded_product_json(server: Server, key: str, value: str) -> None:
    server.set_product(commit=FAKE_COMMIT, **{key: value})
    proc = server.verify()
    assert proc.returncode != 0
    assert key in proc.stderr and value in proc.stderr


def test_verify_refuses_two_top_level_directories(server: Server) -> None:
    write(server.tmp / "tree" / "stray" / "file.txt", "x\n")
    server.extra_top.append("stray")
    proc = server.verify()
    assert proc.returncode != 0
    assert "top-level" in proc.stderr and "stray" in proc.stderr


def test_verify_refuses_a_missing_launcher(server: Server) -> None:
    (server.root / "bin" / "vibe-server").unlink()
    proc = server.verify()
    assert proc.returncode != 0
    assert "bin/vibe-server" in proc.stderr


def test_verify_refuses_a_launcher_that_is_not_executable(server: Server) -> None:
    (server.root / "bin" / "vibe-server").chmod(0o644)
    proc = server.verify()
    assert proc.returncode != 0
    assert "bin/vibe-server" in proc.stderr and "executable" in proc.stderr


def test_verify_refuses_a_node_of_another_platform(server: Server) -> None:
    write_bytes(server.root / "node", MACHO_ARM64, 0o755)
    proc = server.verify()
    assert proc.returncode != 0
    assert "node" in proc.stderr and "Mach-O" in proc.stderr


def test_verify_refuses_a_native_that_needs_a_newer_glibc(server: Server) -> None:
    write_bytes(server.root / NATIVES[3], fake_elf("x64", "2.34"))
    proc = server.verify()
    assert proc.returncode != 0
    assert "2.34" in proc.stderr and "2.28" in proc.stderr and NATIVES[3] in proc.stderr


def test_verify_reports_a_helper_executable_that_needs_a_newer_glibc(server: Server) -> None:
    """The ceiling binds what is loaded into the server process (node, *.node). A prebuilt
    helper that upstream ships and the server merely spawns (the mxc-sdk sandbox launcher
    needs glibc 2.34) cannot be rebuilt here: it must not fail the check, and it must not
    go unmentioned either."""
    helper = "node_modules/@microsoft/mxc-sdk/bin/x64/lxc-exec"
    write_bytes(server.root / helper, fake_elf("x64", "2.34"), 0o755)
    proc = server.verify()
    assert proc.returncode == 0, proc.stdout + proc.stderr
    notes = [line for line in proc.stdout.splitlines() if line.startswith("note: ")]
    assert len(notes) == 1, proc.stdout
    assert helper in notes[0] and "2.34" in notes[0] and "2.28" in notes[0]
    glibc_line = next(line for line in proc.stdout.splitlines() if "newest glibc" in line)
    assert "2.34" not in glibc_line, "the helper must not be counted as loaded by the server"


def test_verify_glibc_ceiling_is_overridable(server: Server) -> None:
    write_bytes(server.root / NATIVES[3], fake_elf("x64", "2.31"))
    proc = server.verify(VIBE_SERVER_MAX_GLIBC="2.31")
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "2.31" in proc.stdout


def test_verify_refuses_a_package_of_another_platform(server: Server) -> None:
    write(server.root / "node_modules" / "@github" / "copilot-darwin-arm64" / "package.json",
          json.dumps({"name": "@github/copilot-darwin-arm64", "os": ["darwin"], "cpu": ["arm64"]}))
    proc = server.verify()
    assert proc.returncode != 0
    assert "@github/copilot-darwin-arm64" in proc.stderr


def test_verify_refuses_a_missing_builtin_extension(server: Server) -> None:
    shutil.rmtree(server.root / "extensions" / "vibe-chandra")
    proc = server.verify()
    assert proc.returncode != 0
    assert "vibe-chandra" in proc.stderr


def test_verify_refuses_a_stale_sha256(server: Server) -> None:
    tarball = server.pack()
    write(Path(f"{tarball}.sha256"), f"{'0' * 64}  {tarball.name}\n")
    proc = run(VERIFY, str(tarball), VIBE_ROOT=str(server.tmp))
    assert proc.returncode != 0
    assert "sha256" in proc.stderr


@pytest.mark.parametrize("args", [[], ["--host"], ["a.tar.gz", "b.tar.gz"], ["a.tar.gz", "--nope"]])
def test_verify_bad_arguments_are_rejected(args: list[str]) -> None:
    proc = run(VERIFY, *args)
    assert proc.returncode == 2, proc.stdout
    assert "usage" in proc.stderr


def test_verify_refuses_a_missing_tarball(tmp_path: Path) -> None:
    missing = tmp_path / f"vibe-server-linux-x64-{FAKE_COMMIT}.tar.gz"
    proc = run(VERIFY, str(missing))
    assert proc.returncode != 0
    assert str(missing) in proc.stderr and "build-server.sh" in proc.stderr


def test_verify_refuses_a_tarball_it_cannot_name(server: Server) -> None:
    renamed = server.tmp / "server.tar.gz"
    server.pack(sidecar=False).rename(renamed)
    proc = run(VERIFY, str(renamed))
    assert proc.returncode != 0
    assert "vibe-server-linux-<arch>-<commit>.tar.gz" in proc.stderr


# --------------------------------------------------------------------------- the real tarball

REAL = sorted((REPO / ".build" / "server").glob("vibe-server-linux-*-*.tar.gz"))


@pytest.mark.skipif(not REAL, reason="no server tarball - run scripts/build-server.sh")
@pytest.mark.parametrize("tarball", REAL, ids=[p.name for p in REAL])
def test_verify_accepts_the_real_tarball(tarball: Path) -> None:
    proc = run(VERIFY, str(tarball))
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert all(line.startswith(("ok: ", "note: ")) for line in proc.stdout.splitlines()), proc.stdout
