"""Vibe scaffold: upstream pin, script hygiene, and the export/apply/check roundtrip.

Every behavioural test runs against a synthetic upstream repo under ``tmp_path``
with all script paths redirected through the ``VIBE_*`` environment overrides; the
real checkout (``vscode/``) is never read or written.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
SCRIPTS = REPO / "scripts"
PIN = REPO / "upstream.json"

RUNNABLE = ["bootstrap.sh", "apply.sh", "export.sh", "check.sh", "build.sh", "run.sh", "test-core.sh"]
ALL_SCRIPTS = ["env.sh", *RUNNABLE]

# macOS ships bash 3.2 at /bin/bash; run the scripts under it so compatibility is tested.
BASH = "/bin/bash" if Path("/bin/bash").exists() else shutil.which("bash")

EXPECTED_PATCHES = {
    ".eslint-ignore.patch",  # a root dotfile: its patch name starts with a dot too
    "product.json.patch",
    "resources__icon.bin.patch",
    "scripts__lint.sh.patch",
    "src__vs__base__common__obsolete.ts.patch",
    "src__vs__workbench__browser__layout.ts.patch",
}
EXPECTED_OVERLAY = {
    "docs/read me.txt",
    "extensions/vibe-chandra/bin/tool.sh",
    "extensions/vibe-chandra/src/model/graph.ts",
}


# --------------------------------------------------------------------------- helpers

def snapshot(root: Path, prune: tuple[str, ...] = (".git",)) -> dict[str, tuple[bytes, bool]]:
    """{posix relpath: (bytes, executable)} for every file under root."""
    out = {}
    for p in sorted(root.rglob("*")):
        rel = p.relative_to(root)
        if any(part in prune for part in rel.parts):
            continue
        if p.is_file():
            out[rel.as_posix()] = (p.read_bytes(), os.access(p, os.X_OK))
    return out


def write(path: Path, data, mode: int = 0o644) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(data, bytes):
        path.write_bytes(data)
    else:
        path.write_text(data)
    path.chmod(mode)


class World:
    """A synthetic upstream, a developer checkout of it, and tracked patches/overlay dirs."""

    def __init__(self, tmp: Path):
        self.tmp = tmp
        self.home = tmp / "home"
        self.home.mkdir()
        self.upstream = tmp / "upstream"
        self.dev = tmp / "dev"
        self.patches = tmp / "tracked" / "patches"
        self.overlay = tmp / "tracked" / "overlay"
        self._make_upstream()
        self.clone(self.dev)

    def env(self, checkout: Path | None = None, **extra: str) -> dict[str, str]:
        env = dict(os.environ)
        for key in [k for k in env if k.startswith(("VIBE_", "GIT_"))]:
            del env[key]
        env.update(
            HOME=str(self.home),
            GIT_CONFIG_NOSYSTEM="1",
            GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@example.invalid",
            GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@example.invalid",
            VIBE_CHECKOUT=str(checkout or self.dev),
            VIBE_PATCHES=str(self.patches),
            VIBE_OVERLAY=str(self.overlay),
            VIBE_TOOLCHAIN=str(self.tmp / "toolchain"),
            VIBE_SKIP_PIN_CHECK="1",
        )
        env.update(extra)
        return env

    def git(self, cwd: Path, *args: str) -> str:
        proc = subprocess.run(["git", "-C", str(cwd), *args], env=self.env(),
                              capture_output=True, text=True, check=True)
        return proc.stdout

    def run(self, script: str, *args: str, checkout: Path | None = None,
            **extra: str) -> subprocess.CompletedProcess:
        return subprocess.run([BASH, str(SCRIPTS / script), *args],
                              env=self.env(checkout, **extra), cwd=str(self.tmp),
                              capture_output=True, text=True)

    def ok(self, script: str, *args: str, **kw) -> subprocess.CompletedProcess:
        proc = self.run(script, *args, **kw)
        assert proc.returncode == 0, f"{script} {args}: rc={proc.returncode}\n{proc.stdout}\n{proc.stderr}"
        return proc

    def clone(self, dst: Path) -> Path:
        subprocess.run(["git", "clone", "-q", str(self.upstream), str(dst)],
                       env=self.env(), check=True, capture_output=True)
        return dst

    def _make_upstream(self) -> None:
        up = self.upstream
        write(up / ".gitignore", "node_modules/\nout/\n")
        write(up / ".eslint-ignore", "**/vendor/**\n")
        write(up / "product.json", '{\n\t"nameShort": "Code - OSS",\n\t"nameLong": "Code - OSS"\n}\n')
        write(up / "src/vs/workbench/browser/layout.ts",
              "".join(f"export const line{i} = {i};\n" for i in range(1, 13)))
        write(up / "src/vs/base/common/obsolete.ts", "export const gone = true;\n")
        write(up / "scripts/code.sh", '#!/usr/bin/env bash\nprintf "code:%s\\n" "$@"\n', 0o755)
        write(up / "scripts/test.sh", '#!/usr/bin/env bash\nprintf "%s\\n" "$@"\n', 0o755)
        write(up / "scripts/lint.sh", "#!/usr/bin/env bash\ntrue\n", 0o644)
        write(up / "resources/icon.bin", bytes(range(256)) * 4)
        self.git(self.tmp, "init", "-q", "-b", "main", str(up))
        self.git(up, "add", "-A")
        self.git(up, "commit", "-q", "-m", "upstream")
        self.git(up, "tag", "v0")

    def develop(self) -> None:
        """Edits of every kind the fork can make, plus ignored build output."""
        dev = self.dev
        layout = dev / "src/vs/workbench/browser/layout.ts"
        layout.write_text(layout.read_text().replace("line6 = 6", "line6 = 66")
                          + "export const workspaceBar = true;\n")
        (dev / "product.json").write_text('{\n\t"nameShort": "Vibe",\n\t"nameLong": "Vibe Slop Code"\n}\n')
        with (dev / ".eslint-ignore").open("a") as fh:
            fh.write("extensions/vibe-chandra/bin/**\n")
        (dev / "src/vs/base/common/obsolete.ts").unlink()
        (dev / "resources/icon.bin").write_bytes(bytes(reversed(range(256))) * 3)
        (dev / "scripts/lint.sh").chmod(0o755)
        write(dev / "extensions/vibe-chandra/src/model/graph.ts", "export const graph = 1;\n")
        write(dev / "extensions/vibe-chandra/bin/tool.sh", "#!/usr/bin/env bash\ntrue\n", 0o755)
        write(dev / "docs/read me.txt", "a path with a space\n")
        write(dev / "node_modules/x/index.js", "module.exports = 1;\n")
        write(dev / "out/main.js", "compiled\n")


@pytest.fixture
def world(tmp_path: Path) -> World:
    return World(tmp_path)


@pytest.fixture
def exported(world: World) -> World:
    world.develop()
    world.ok("export.sh")
    return world


# --------------------------------------------------------------------------- static

def test_pin_file_shape():
    pin = json.loads(PIN.read_text())
    assert set(pin) == {"repo", "tag", "commit", "node"}
    assert all(isinstance(v, str) for v in pin.values())
    assert re.fullmatch(r"https://github\.com/microsoft/vscode(\.git)?", pin["repo"])
    assert re.fullmatch(r"\d+\.\d+\.\d+", pin["tag"])
    assert re.fullmatch(r"[0-9a-f]{40}", pin["commit"])
    assert re.fullmatch(r"\d+\.\d+\.\d+", pin["node"])


def test_env_reads_pin_like_a_json_parser(world: World):
    pin = json.loads(PIN.read_text())
    env = world.env()
    del env["VIBE_CHECKOUT"], env["VIBE_PATCHES"], env["VIBE_OVERLAY"], env["VIBE_TOOLCHAIN"]
    script = f'. "{SCRIPTS / "env.sh"}"; for k in repo tag commit node; do vibe_pin "$k"; done; echo "$VIBE_ROOT"'
    proc = subprocess.run([BASH, "-euc", script], env=env, capture_output=True, text=True, check=True)
    assert proc.stdout.split("\n")[:5] == [pin["repo"], pin["tag"], pin["commit"], pin["node"], str(REPO)]


@pytest.mark.parametrize("name", ALL_SCRIPTS)
def test_script_exists_executable_and_parses(name: str):
    path = SCRIPTS / name
    assert path.is_file(), f"missing {path}"
    assert os.access(path, os.X_OK), f"{name} is not executable"
    proc = subprocess.run([BASH, "-n", str(path)], capture_output=True, text=True)
    assert proc.returncode == 0, proc.stderr
    text = path.read_text()
    assert text.startswith("#!/usr/bin/env bash\n")
    banned = re.search(r"\b(mapfile|readarray)\b|declare -A|local -n|\$\{[^}]*(\^\^|,,)\}", text)
    assert not banned, f"{name}: bash 4+ construct {banned.group(0)!r}"


@pytest.mark.parametrize("name", RUNNABLE)
def test_runnable_script_is_strict(name: str):
    assert "\nset -euo pipefail\n" in (SCRIPTS / name).read_text()


def test_tracked_dirs_and_readme_exist():
    assert (REPO / "patches" / ".gitkeep").is_file()
    assert (REPO / "overlay" / ".gitkeep").is_file()
    readme = (REPO / "README.md").read_text()
    for needle in ("bootstrap.sh", "export.sh", "check.sh", "upstream.json", "DESIGN.md"):
        assert needle in readme


@pytest.mark.skipif(not (REPO / ".git").exists(), reason="not a git work tree")
def test_gitignore_hides_checkout_but_never_overlay_content():
    def ignored(path: str) -> bool:
        return subprocess.run(["git", "-C", str(REPO), "check-ignore", "-q", "--no-index", path]).returncode == 0

    assert ignored("vscode/package.json")
    assert ignored(".toolchain/node/bin/node")
    assert ignored(".build/x")
    assert ignored("VSCode-darwin-arm64/x")
    assert not ignored("patches/product.json.patch")
    assert not ignored("overlay/resources/a.pdf")
    # The rules are anchored at the root: a folder of the same name inside overlay/ is content.
    for name in ("vscode", ".toolchain", ".build", "VSCode-darwin-arm64"):
        assert not ignored(f"overlay/extensions/vibe-chandra/{name}/x.ts")


# --------------------------------------------------------------------------- export

def test_export_writes_one_patch_per_path_and_mirrors_new_files(exported: World):
    w = exported
    patches = {p.name for p in w.patches.iterdir()} - {".gitkeep"}
    assert patches == EXPECTED_PATCHES
    assert set(snapshot(w.overlay)) - {".gitkeep"} == EXPECTED_OVERLAY

    layout = (w.patches / "src__vs__workbench__browser__layout.ts.patch").read_text()
    assert layout.startswith("diff --git a/src/vs/workbench/browser/layout.ts b/src/vs/workbench/browser/layout.ts\n")
    assert "+export const workspaceBar = true;" in layout
    assert "deleted file mode" in (w.patches / "src__vs__base__common__obsolete.ts.patch").read_text()
    assert "GIT binary patch" in (w.patches / "resources__icon.bin.patch").read_text()
    assert "new mode 100755" in (w.patches / "scripts__lint.sh.patch").read_text()
    assert (w.patches / ".eslint-ignore.patch").read_text().startswith("diff --git a/.eslint-ignore b/.eslint-ignore\n")

    overlay = snapshot(w.overlay)
    assert overlay["extensions/vibe-chandra/src/model/graph.ts"] == (b"export const graph = 1;\n", False)
    assert overlay["extensions/vibe-chandra/bin/tool.sh"][1] is True, "executable bit lost"
    everything = "\n".join([*snapshot(w.patches), *overlay])
    assert "node_modules" not in everything and "main.js" not in everything


def test_export_is_deterministic(exported: World):
    w = exported
    first = (snapshot(w.patches), snapshot(w.overlay))
    w.ok("export.sh")
    assert (snapshot(w.patches), snapshot(w.overlay)) == first

    out = w.tmp / "elsewhere"
    w.ok("export.sh", "--out", str(out))
    assert (snapshot(out / "patches"), snapshot(out / "overlay")) == first
    assert (snapshot(w.patches), snapshot(w.overlay)) == first, "--out must not touch the tracked dirs"


def test_export_ignores_user_git_config(exported: World):
    w = exported
    first = (snapshot(w.patches), snapshot(w.overlay))
    (w.home / ".gitconfig").write_text(
        "[diff]\n\tnoprefix = true\n\tmnemonicPrefix = true\n\tcontext = 1\n\talgorithm = patience\n"
        "\texternal = /usr/bin/false\n[core]\n\tabbrev = 5\n\tquotepath = true\n[color]\n\tui = always\n")
    out = w.tmp / "hostile"
    w.ok("export.sh", "--out", str(out))
    assert (snapshot(out / "patches"), snapshot(out / "overlay")) == first


def test_export_prunes_stale_outputs(exported: World):
    w = exported
    write(w.patches / "junk.patch", "stale\n")
    write(w.overlay / "gone/old.ts", "stale\n")
    w.git(w.dev, "checkout", "--", "product.json")
    shutil.rmtree(w.dev / "docs")
    w.ok("export.sh")
    assert {p.name for p in w.patches.iterdir()} - {".gitkeep"} == EXPECTED_PATCHES - {"product.json.patch"}
    assert set(snapshot(w.overlay)) - {".gitkeep"} == EXPECTED_OVERLAY - {"docs/read me.txt"}
    assert not (w.overlay / "gone").exists() and not (w.overlay / "docs").exists()


def test_export_refuses_staged_changes(exported: World):
    w = exported
    before = (snapshot(w.patches), snapshot(w.overlay))
    w.git(w.dev, "add", "extensions/vibe-chandra/src/model/graph.ts")
    proc = w.run("export.sh")
    assert proc.returncode != 0 and "staged" in proc.stderr
    assert (snapshot(w.patches), snapshot(w.overlay)) == before


def test_export_of_pristine_checkout_is_empty(world: World):
    world.ok("export.sh")
    assert [p.name for p in world.patches.iterdir()] == [".gitkeep"]
    assert list(snapshot(world.overlay)) == [".gitkeep"]


# --------------------------------------------------------------------------- check

def test_check_passes_on_exported_state_and_fails_after_any_edit(exported: World):
    w = exported
    before = (snapshot(w.patches), snapshot(w.overlay))
    w.ok("check.sh")
    assert (snapshot(w.patches), snapshot(w.overlay)) == before, "check must be read-only"

    with (w.dev / "product.json").open("a") as fh:
        fh.write("\n")
    assert w.run("check.sh").returncode != 0
    w.ok("export.sh")
    w.ok("check.sh")

    write(w.dev / "extensions/vibe-chandra/src/view/layout.ts", "export {};\n")
    assert w.run("check.sh").returncode != 0
    w.ok("export.sh")
    w.ok("check.sh")

    (w.dev / "extensions/vibe-chandra/src/view/layout.ts").chmod(0o755)
    assert w.run("check.sh").returncode != 0, "executable-bit drift must be caught"
    w.ok("export.sh")
    w.ok("check.sh")

    with (w.dev / ".eslint-ignore").open("a") as fh:
        fh.write("more/**\n")
    assert w.run("check.sh").returncode != 0, "a root dotfile's patch is compared too"


# --------------------------------------------------------------------------- apply

def test_apply_reproduces_the_working_tree(exported: World):
    w = exported
    fresh = w.clone(w.tmp / "fresh")
    applied = w.ok("apply.sh", checkout=fresh)
    # Every patch exactly once, the dotfile ones included.
    assert f"applied {len(EXPECTED_PATCHES)} patches," in applied.stdout
    ignored = (".git", "node_modules", "out")
    assert snapshot(fresh, ignored) == snapshot(w.dev, ignored)
    assert not (fresh / ".gitkeep").exists()
    assert w.git(fresh, "status", "--porcelain") == w.git(w.dev, "status", "--porcelain")
    # export(apply(x)) == x: the tracked state is a fixed point of the two scripts.
    w.ok("check.sh", checkout=fresh)


def test_apply_refuses_dirty_checkout_unless_forced(exported: World):
    w = exported
    fresh = w.clone(w.tmp / "fresh")
    w.ok("apply.sh", checkout=fresh)
    write(fresh / "node_modules/x/index.js", "module.exports = 1;\n")
    write(fresh / "stray.txt", "unexported work\n")
    (fresh / "product.json").write_text("{}\n")
    w.git(fresh, "add", "stray.txt")
    dirty = snapshot(fresh)

    proc = w.run("apply.sh", checkout=fresh)
    assert proc.returncode != 0
    assert "--force" in proc.stderr and "product.json" in proc.stderr
    assert snapshot(fresh) == dirty, "a refused apply must not touch the checkout"

    w.ok("apply.sh", "--force", checkout=fresh)
    ignored = (".git", "node_modules", "out")
    assert snapshot(fresh, ignored) == snapshot(w.dev, ignored)
    assert not (fresh / "stray.txt").exists()
    assert (fresh / "node_modules/x/index.js").read_text() == "module.exports = 1;\n"
    w.ok("check.sh", checkout=fresh)


def test_apply_with_missing_or_empty_tracked_dirs(world: World):
    pristine = snapshot(world.dev)
    assert not world.patches.exists() and not world.overlay.exists()
    world.ok("apply.sh")
    assert snapshot(world.dev) == pristine

    write(world.patches / ".gitkeep", "")
    write(world.overlay / ".gitkeep", "")
    world.ok("apply.sh")
    assert snapshot(world.dev) == pristine


def test_apply_is_all_or_nothing_when_a_patch_conflicts(exported: World):
    w = exported
    fresh = w.clone(w.tmp / "fresh")
    # The conflicting patch sorts last, so a naive apply loop would already have applied the others.
    layout = fresh / "src/vs/workbench/browser/layout.ts"
    layout.write_text(layout.read_text().replace("line6 = 6", "line6 = 600"))
    w.git(fresh, "commit", "-qam", "upstream drift")
    pristine = snapshot(fresh)
    proc = w.run("apply.sh", checkout=fresh)
    assert proc.returncode != 0
    assert "src__vs__workbench__browser__layout.ts.patch" in proc.stderr
    assert "product.json.patch" not in proc.stderr.split("nothing was changed")[1]
    assert snapshot(fresh) == pristine


def test_apply_checks_dotfile_patches_before_applying_any(exported: World):
    w = exported
    fresh = w.clone(w.tmp / "fresh")
    (fresh / ".eslint-ignore").write_text("**/elsewhere/**\n")
    w.git(fresh, "commit", "-qam", "upstream drift")
    pristine = snapshot(fresh)
    proc = w.run("apply.sh", checkout=fresh)
    assert proc.returncode != 0
    assert ".eslint-ignore.patch" in proc.stderr.split("nothing was changed")[1]
    assert snapshot(fresh) == pristine


def test_apply_enforces_the_pin(exported: World):
    w = exported
    head = w.git(w.upstream, "rev-parse", "HEAD").strip()
    pin = w.tmp / "upstream.json"
    fresh = w.clone(w.tmp / "fresh")

    pin.write_text(json.dumps({"repo": "x", "tag": "v0", "commit": "0" * 40, "node": "1.2.3"}, indent=2))
    proc = w.run("apply.sh", checkout=fresh, VIBE_PIN=str(pin), VIBE_SKIP_PIN_CHECK="0")
    assert proc.returncode != 0 and "0" * 40 in proc.stderr
    assert w.git(fresh, "status", "--porcelain") == ""

    pin.write_text(json.dumps({"repo": "x", "tag": "v0", "commit": head, "node": "1.2.3"}, indent=2))
    w.ok("apply.sh", checkout=fresh, VIBE_PIN=str(pin), VIBE_SKIP_PIN_CHECK="0")


@pytest.mark.parametrize("script,arg", [("apply.sh", "--frce"), ("export.sh", "--bogus"),
                                        ("export.sh", "--out"), ("bootstrap.sh", "--nope")])
def test_unknown_arguments_are_rejected(exported: World, script: str, arg: str):
    before = snapshot(exported.dev)
    proc = exported.run(script, arg)
    assert proc.returncode == 2 and "usage" in proc.stderr
    assert snapshot(exported.dev) == before


# --------------------------------------------------------------------------- bootstrap + thin wrappers

def fake_toolchain(w: World, version: str = "1.2.3") -> Path:
    bin_dir = w.tmp / "toolchain" / "node" / "bin"
    write(bin_dir / "node", f'#!/usr/bin/env bash\necho "v{version}"\n', 0o755)
    write(bin_dir / "npm", '#!/usr/bin/env bash\necho "npm:$PWD:$*"\n', 0o755)
    return bin_dir


def test_bootstrap_clones_pin_applies_and_is_idempotent(exported: World):
    w = exported
    fake_toolchain(w)
    head = w.git(w.upstream, "rev-parse", "HEAD").strip()
    pin = w.tmp / "upstream.json"
    pin.write_text(json.dumps({"repo": w.upstream.as_uri(), "tag": "v0", "commit": head, "node": "1.2.3"}, indent=2))
    checkout = w.tmp / "boot" / "vscode"
    kw = dict(checkout=checkout, VIBE_PIN=str(pin), VIBE_SKIP_PIN_CHECK="0")

    first = w.ok("bootstrap.sh", **kw)
    assert f"npm:{checkout.resolve()}:ci" in first.stdout.replace(str(checkout), str(checkout.resolve()))
    ignored = (".git", "node_modules", "out")
    assert snapshot(checkout, ignored) == snapshot(w.dev, ignored)

    write(checkout / "wip.ts", "unexported work\n")
    state = snapshot(checkout)
    second = w.ok("bootstrap.sh", "--no-install", **kw)
    assert "npm:" not in second.stdout
    assert snapshot(checkout) == state, "re-running bootstrap must not clobber work in the checkout"


def test_bootstrap_rejects_a_moved_tag(exported: World):
    w = exported
    fake_toolchain(w)
    pin = w.tmp / "upstream.json"
    pin.write_text(json.dumps({"repo": w.upstream.as_uri(), "tag": "v0", "commit": "0" * 40, "node": "1.2.3"}, indent=2))
    proc = w.run("bootstrap.sh", "--no-install", checkout=w.tmp / "boot", VIBE_PIN=str(pin), VIBE_SKIP_PIN_CHECK="0")
    assert proc.returncode != 0 and "0" * 40 in proc.stderr


def test_build_and_run_are_thin_wrappers_on_the_pinned_toolchain(world: World):
    fake_toolchain(world)
    built = world.ok("build.sh")
    assert built.stdout.strip().endswith(":run compile")
    assert Path(built.stdout.split(":")[1]).resolve() == world.dev.resolve()
    ran = world.ok("run.sh", "--wait", "some dir")
    assert ran.stdout.splitlines() == ["code:--wait", "code:some dir"]


def test_test_core_maps_files_and_globs_to_upstream_flags(world: World):
    files = world.ok("test-core.sh", "src/vs/a/test/common/x.test.ts", "vs/b/test/y.test.js")
    assert files.stdout.splitlines() == ["--run", "src/vs/a/test/common/x.test.ts", "--run", "vs/b/test/y.test.js"]

    # Upstream resolves globs against out/ and compiled .js, so source-style globs are translated.
    glob = world.ok("test-core.sh", "src/vs/platform/workspaceBar/**/*.test.ts")
    assert glob.stdout.splitlines() == ["--runGlob", "vs/platform/workspaceBar/**/*.test.js"]

    assert world.run("test-core.sh").returncode == 2
    # Upstream takes a single glob and silently drops it when --run is present: refuse instead.
    assert world.run("test-core.sh", "**/a.test.js", "**/b.test.js").returncode == 2
    assert world.run("test-core.sh", "**/a.test.js", "src/vs/x.test.ts").returncode == 2
