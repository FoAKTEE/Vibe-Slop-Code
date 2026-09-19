"""The commit-message gate: ``.githooks/commit-msg`` and ``scripts/install-hooks.sh``.

The gate enforces the title grammar of ``docs/commit_template.md``: a title that fails it
is rejected; body, footer and claim-tag problems are warnings that ``COMMIT_GATE_STRICT=1``
turns into errors. Each case writes a message to a temp file and runs the hook standalone
(exit 0 = admit, exit 1 = reject), under the bash 3.2 that macOS ships.

``install-hooks.sh`` is run in a throwaway repository that holds a copy of the script and
the hook, never against this clone's own git config.
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
HOOK = REPO / ".githooks" / "commit-msg"
INSTALL = REPO / "scripts" / "install-hooks.sh"
TEMPLATE = REPO / "docs" / "commit_template.md"

# macOS ships bash 3.2 at /bin/bash; run the scripts under it so compatibility is tested.
BASH = "/bin/bash" if Path("/bin/bash").exists() else shutil.which("bash")


def gate(tmp_path: Path, message: str, strict: bool = False) -> subprocess.CompletedProcess:
    msg_file = tmp_path / "COMMIT_EDITMSG"
    msg_file.write_text(message, encoding="utf-8")
    env = {k: v for k, v in os.environ.items() if k != "COMMIT_GATE_STRICT"}
    if strict:
        env["COMMIT_GATE_STRICT"] = "1"
    return subprocess.run([BASH, str(HOOK), str(msg_file)], capture_output=True, text=True, env=env)


# --------------------------------------------------------------------------- static

def test_hook_and_template_exist() -> None:
    assert HOOK.is_file(), f"missing {HOOK}"
    assert os.access(HOOK, os.X_OK), "git runs the hook only when it is executable"
    assert TEMPLATE.is_file(), f"missing {TEMPLATE}"


@pytest.mark.parametrize("script", [HOOK, INSTALL], ids=["commit-msg", "install-hooks.sh"])
def test_script_parses_under_bash_3(script: Path) -> None:
    assert script.is_file(), f"missing {script}"
    proc = subprocess.run([BASH, "-n", str(script)], capture_output=True, text=True)
    assert proc.returncode == 0, proc.stderr
    text = script.read_text(encoding="utf-8")
    assert text.startswith("#!/usr/bin/env bash\n")
    banned = re.search(r"\b(mapfile|readarray)\b|declare -A|local -n|\$\{[^}]*(\^\^|,,)\}", text)
    assert not banned, f"{script.name}: bash 4+ construct {banned.group(0)!r}"


# A path-like token: segments joined by "/", read as a file path when it starts with "." or
# "_" or its last segment has an extension. Prose such as "body/footer" is not one.
PATH_TOKEN = re.compile(r"(?<![\w./-])[\w.-]+(?:/[\w.-]+)+")


def referenced_paths(text: str) -> list[str]:
    tokens = (token.rstrip(".") for token in PATH_TOKEN.findall(text))
    return sorted({t for t in tokens if t.startswith((".", "_")) or "." in t.rsplit("/", 1)[1]})


@pytest.mark.parametrize("path", [HOOK, INSTALL, TEMPLATE], ids=["commit-msg", "install-hooks.sh", "commit_template.md"])
def test_every_path_named_exists_in_this_repo(path: Path) -> None:
    named = referenced_paths(path.read_text(encoding="utf-8"))
    missing = [p for p in named if not (REPO / p).exists()]
    assert not missing, f"{path.name} names paths this repository does not have: {missing}"


def test_hook_points_at_the_template() -> None:
    text = HOOK.read_text(encoding="utf-8")
    assert "docs/commit_template.md" in referenced_paths(text)
    assert "scripts/install-hooks.sh" in referenced_paths(text)


def test_path_detection_is_not_blind() -> None:
    """The existence test above is only as good as the token scan."""
    assert referenced_paths("spec: _common/contracts/commit_template.md; see .githooks/x "
                            "and docs/a.md. Not body/footer/claim-tag or diag/exp/chore.") == [
        ".githooks/x", "_common/contracts/commit_template.md", "docs/a.md"]


# --------------------------------------------------------------------------- admitted

ADMIT = [
    # subject-only, core Conventional Commits types
    "feat(wsbar): workspace-bar model — identity, hosts, MRU, persistence",
    "fix(scaffold): apply dotfile patches too",
    "perf(dag): lay out large graphs in one pass",
    "refactor(repo): make the repository root the Vibe root",
    "docs(design): remote SSH hosts from ~/.ssh/config",
    "test(remote): cover the upload of a damaged tarball",
    "revert(branding): undo the icon change",
    # the research-log and process types
    "diag(remote): localize the server start failure to the glibc floor",
    "exp(server): build vibe-server for linux-arm64",
    "chore(deps): refresh the extension lock files",
    "infra(repo): carry the commit-message gate into this repository",
    "notes(vibe): record the launcher decision",
    # several scopes
    "fix(remote,wsbar): list a remote window in the bar",
    # breaking change, properly paired
    (
        "fix(remote)!: key installed servers by commit\n"
        "\n"
        "- finding: a server of another commit was reused [SOLID]\n"
        "\n"
        "BREAKING CHANGE: servers installed under ~/.vibe-server/bin/<name> are no longer found\n"
    ),
    # full typed body with tagged claims and trailers
    (
        "feat(agents): Agents view — which agent is working, waiting, done\n"
        "\n"
        "- why: one glance should say where an agent waits\n"
        "- change: a webview with one card per session\n"
        "- result: 213 tests pass [SOLID]\n"
        "- verify: npm test\n"
        "- files: overlay/extensions/vibe-agents/src/extension.ts\n"
        "\n"
        "Claim: SOLID — the view; Modality: CrossCheck\n"
    ),
    # git comment lines are not part of the message
    "# Please enter the commit message for your changes.\nfix(dag): open large graphs legibly\n# On branch main\n",
]


@pytest.mark.parametrize("message", ADMIT)
def test_admits_a_valid_message(tmp_path: Path, message: str) -> None:
    proc = gate(tmp_path, message)
    assert proc.returncode == 0, f"wrongly rejected:\n{message}\n{proc.stderr}"
    assert gate(tmp_path, message, strict=True).returncode == 0, "no warning either"


# --------------------------------------------------------------------------- rejected

REJECT = [
    "Initial commit",                             # no type
    "make the repository root the Vibe root",     # no type
    "Refactor repo layout",                       # capitalized, no type token
    "wip: half-done thing",                       # unknown type
    "feat add the Agents view",                   # no colon
    "feat(): empty scope",                        # an empty scope fails [^)]+
    "feat(wsbar):no space after the colon",       # ": " is part of the grammar
    "wsbar: a scope is not a type",
    "FEAT(wsbar): types are lowercase",
]


@pytest.mark.parametrize("message", REJECT)
def test_rejects_a_bad_title(tmp_path: Path, message: str) -> None:
    proc = gate(tmp_path, message)
    assert proc.returncode == 1, f"wrongly admitted:\n{message}"
    assert "REJECTED" in proc.stderr and "docs/commit_template.md" in proc.stderr
    assert "--no-verify" in proc.stderr


def test_a_bad_title_is_found_below_blank_lines(tmp_path: Path) -> None:
    assert gate(tmp_path, "\n\nnot a title\n\n- change: x\n").returncode == 1


# --------------------------------------------------------------------------- pass-through

@pytest.mark.parametrize("message", [
    "Merge branch 'feature' into main",
    'Revert "feat(agents): Agents view"',
    "fixup! feat(agents): Agents view",
    "squash! feat(agents): Agents view",
    "amend! feat(agents): Agents view",
    "",
    "\n\n# only comments here\n",
])
def test_passes_through_what_git_writes_itself(tmp_path: Path, message: str) -> None:
    assert gate(tmp_path, message, strict=True).returncode == 0


def test_a_missing_message_file_never_blocks(tmp_path: Path) -> None:
    for args in ([], [str(tmp_path / "no-such-file")]):
        proc = subprocess.run([BASH, str(HOOK), *args], capture_output=True, text=True)
        assert proc.returncode == 0, args
        assert "no message file" in proc.stderr


# --------------------------------------------------------------------------- warnings and strict mode

WARN = {
    "untagged finding": "diag(dag): a finding\n\n- finding: no claim tag here\n",
    "untagged result": "feat(dag): a result\n\n- result: 3 of 3 pass\n",
    "unknown body kind": "feat(dag): a body\n\n- tests: an unknown kind\n",
    "no blank line after the title": "feat(dag): a body\n- change: glued to the title\n",
    "trailing period": "feat(dag): ends with a period.",
    "long title": "feat(dag): " + "x" * 100,
    "bang without footer": "fix(dag)!: overturn a result",
    "footer without bang": "fix(dag): overturn a result\n\nBREAKING CHANGE: the old layout\n",
}


@pytest.mark.parametrize("message", WARN.values(), ids=WARN.keys())
def test_strict_mode_escalates_every_warning(tmp_path: Path, message: str) -> None:
    advisory = gate(tmp_path, message)
    assert advisory.returncode == 0, advisory.stderr
    assert "admitted with 1 warning(s)" in advisory.stderr
    strict = gate(tmp_path, message, strict=True)
    assert strict.returncode == 1
    assert "REJECTED" in strict.stderr


def test_only_strict_1_is_strict(tmp_path: Path) -> None:
    msg_file = tmp_path / "COMMIT_EDITMSG"
    msg_file.write_text(WARN["untagged finding"], encoding="utf-8")
    for value in ("0", "", "yes"):
        env = {**os.environ, "COMMIT_GATE_STRICT": value}
        assert subprocess.run([BASH, str(HOOK), str(msg_file)], capture_output=True, env=env).returncode == 0, value


# --------------------------------------------------------------------------- install-hooks.sh

def git_env(tmp: Path) -> dict[str, str]:
    env = {k: v for k, v in os.environ.items() if not k.startswith(("GIT_", "COMMIT_GATE"))}
    home = tmp / "home"
    home.mkdir(exist_ok=True)
    env.update(HOME=str(home), GIT_CONFIG_NOSYSTEM="1",
               GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@example.invalid",
               GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@example.invalid")
    return env


@pytest.fixture
def clone(tmp_path: Path) -> Path:
    """A throwaway repository laid out like this one: the script and the hook, nothing else."""
    root = tmp_path / "clone"
    (root / "scripts").mkdir(parents=True)
    (root / ".githooks").mkdir()
    shutil.copy2(INSTALL, root / "scripts" / "install-hooks.sh")
    shutil.copy2(HOOK, root / ".githooks" / "commit-msg")
    subprocess.run(["git", "init", "-q", str(root)], env=git_env(tmp_path), check=True)
    return root


def install(clone: Path, *args: str, cwd: Path | None = None) -> subprocess.CompletedProcess:
    return subprocess.run([BASH, str(clone / "scripts" / "install-hooks.sh"), *args], cwd=str(cwd or clone),
                          capture_output=True, text=True, env=git_env(clone.parent))


def hooks_path(clone: Path) -> str:
    return subprocess.run(["git", "-C", str(clone), "config", "--local", "--get", "core.hooksPath"],
                          capture_output=True, text=True, env=git_env(clone.parent)).stdout.strip()


def test_install_sets_the_hooks_path_and_is_idempotent(clone: Path, tmp_path: Path) -> None:
    first = install(clone, cwd=tmp_path)  # from anywhere: the script finds its own clone
    assert first.returncode == 0, first.stderr
    assert hooks_path(clone) == ".githooks"
    assert "core.hooksPath" in first.stdout and ".githooks" in first.stdout

    second = install(clone)
    assert second.returncode == 0, second.stderr
    assert hooks_path(clone) == ".githooks"
    assert "already" in second.stdout


def test_install_names_the_value_it_replaces(clone: Path) -> None:
    subprocess.run(["git", "-C", str(clone), "config", "core.hooksPath", "elsewhere/hooks"],
                   env=git_env(clone.parent), check=True)
    proc = install(clone)
    assert proc.returncode == 0, proc.stderr
    assert "elsewhere/hooks" in proc.stdout
    assert hooks_path(clone) == ".githooks"


def test_install_refuses_without_the_hook(clone: Path) -> None:
    (clone / ".githooks" / "commit-msg").unlink()
    proc = install(clone)
    assert proc.returncode != 0 and "commit-msg" in proc.stderr
    assert hooks_path(clone) == ""


def test_install_refuses_outside_a_work_tree(tmp_path: Path) -> None:
    root = tmp_path / "plain"
    (root / "scripts").mkdir(parents=True)
    (root / ".githooks").mkdir()
    shutil.copy2(INSTALL, root / "scripts" / "install-hooks.sh")
    shutil.copy2(HOOK, root / ".githooks" / "commit-msg")
    proc = install(root)
    assert proc.returncode != 0 and "git" in proc.stderr


def test_rejects_unknown_arguments(clone: Path) -> None:
    proc = install(clone, "--bogus")
    assert proc.returncode == 2 and "usage" in proc.stderr
    assert hooks_path(clone) == ""


def test_installed_gate_guards_real_commits(clone: Path) -> None:
    assert install(clone).returncode == 0
    env = git_env(clone.parent)
    (clone / "a.txt").write_text("a\n", encoding="utf-8")
    subprocess.run(["git", "-C", str(clone), "add", "a.txt"], env=env, check=True)

    bad = subprocess.run(["git", "-C", str(clone), "commit", "-q", "-m", "add a file"],
                         capture_output=True, text=True, env=env)
    assert bad.returncode != 0 and "REJECTED" in bad.stderr
    good = subprocess.run(["git", "-C", str(clone), "commit", "-q", "-m", "chore(repo): add a file"],
                          capture_output=True, text=True, env=env)
    assert good.returncode == 0, good.stderr
