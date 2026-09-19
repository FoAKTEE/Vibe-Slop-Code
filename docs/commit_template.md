# Commit Message Template — Conventional Commits for a verified-research log

> **Enforcement.** This is the spec for the **commit-msg gate** — `.githooks/commit-msg`,
> activated per-clone by `scripts/install-hooks.sh` (sets `core.hooksPath`). The gate
> **hard-rejects** any commit whose title violates §2/§11; body, footer, and claim-tag
> rules are advisory warnings (escalated to errors under `COMMIT_GATE_STRICT=1`).
> Self-test: `python3 -m pytest tests/test_commit_msg_gate.py`.

> **Purpose.** A single, parseable template for both the commit **title** and **body**,
> derived from [Conventional Commits v1.0.0](https://www.conventionalcommits.org/en/v1.0.0/)
> and fitted to an agentic, verified-research lab notebook. Two hard requirements:
> 1. **Types are fully separable** — the leading `type(scope):` token is a single
>    machine-parseable field (§2 grammar, §11 regex), so any tool can bucket commits by type.
> 2. **The body is a list of objects** — each body line is one typed object
>    `- <kind>: …` from a fixed enum (§5), uniform across all types.

This template is **project-independent** — scopes/examples below are illustrative categories, not a fixed vocabulary; a consumer repo names its own figures/subsystems.

---

## 0. Copy-paste skeleton

```
<type>(<scope>)[!]: <imperative summary, ≤ ~72 chars>

- why:     <trigger — user directive / prior result / idle-compute rationale>   (optional)
- finding: <typed claim: root-cause / disproof / measurement / reframe>  [CLAIM-TAG]
- change:  <concrete edit: file:line, new script, default, deletion, revert>
- run:     <compute job: run-id, scale, params, failure mode>
- result:  <outcome with numbers>  [CLAIM-TAG]
- verify:  <method + modality + verdict: VLM / subagent <id> / probe / residual>
- caveat:  <honest limitation / open hole / [FUTURE]>
- next:    <planned next step / in-progress / awaiting>
- files:   <files added / changed / removed>

Iter: <NNN[letter]>            # or  Window: <N>
Run: <id> — <description>      # repeatable
Refs: <file:line; eq; paper l.NNN>
Verify: <evidence, TRF-R>      # repeatable
Claim: <LEVEL> — <gist>; Modality: <…>
BREAKING CHANGE: <what prior result/default this invalidates>   # only with `!`
```

- The **title** is mandatory. **Every** body object and **every** footer is **optional** —
  a subject-only commit (the common case) is just the title line.
- Pick **exactly one** primary `type` (§3 decision tree). The body objects are a list;
  include only the kinds you need, in the order above.

---

## 1. Relationship to Conventional Commits

The title grammar is **identical** to Conventional Commits (`type(scope)!: description`),
and `feat`/`fix` keep their CC meaning. We deviate in exactly one philosophical way: this
is **not** a release-versioned codebase, it is a **scientific iteration log**. So:

- the type set is extended with the two activities that dominate a research log —
  **`diag`** (diagnosis) and **`exp`** (experiment) — plus the methodology-process types
  **`infra`** and **`notes`** (§3b). CC permits "other types"; the fallback column lets a
  strict-CC tool collapse them.
- the free-form body is upgraded to a **list of typed objects** (§5) so claims stay
  auditable: every result carries context + claim type + evidence modality + verifier status.
- `!` / `BREAKING CHANGE:` are repurposed from SemVer-major to **result-invalidating** — a
  correction/disproof overturning a prior committed claim/default (§8); footers are
  ordinary git trailers (`Token: value`, §6).

---

## 2. Title grammar

```
<type>(<scope>)[!]: <summary>
```

EBNF:

```
title    = type [ "(" scope { "," scope } ")" ] [ "!" ] ": " summary
type     = "feat" | "fix" | "perf" | "refactor" | "docs" | "test"
         | "build" | "ci" | "style" | "revert"          ; core Conventional Commits
         | "diag" | "exp" | "chore"                       ; research-log taxonomy (chore is CC too)
         | "infra" | "notes"                              ; methodology-repo process types (§3b)
scope    = identifier from §4 (lowercase or figure-id)
summary  = imperative, no trailing period, ≤ ~72 chars
```

Rules:
- **One** `type`. **Zero or more** `scope`s (comma-separated, no spaces): `fix(fig6,source):`.
- `!` *only* for result-invalidating changes (§8).
- `summary` is a terse imperative gist. If you are tempted to write a paragraph in the
  title, **stop and move the detail into body objects** (§5).
- Keep iteration markers (`Iter 312`, `Window #10`) **out of the title** — they go in the
  `Iter:`/`Window:` footer (§6). This keeps the type token in column 1 for parsers.

---

## 3. Type taxonomy + decision tree

### 3a. Core Conventional Commits types

| type | use when the commit's primary intent is… |
|---|---|
| `feat` | a **new** figure/repro, solver, worker, driver, render, or data product |
| `fix` | **correct a bug** (numerical / code / config) so output becomes right |
| `perf` | **speed up** with no change to results |
| `refactor` | restructure code, **no behavior change** |
| `docs` | writeups, result `.md`, trackers, checkpoints/self-prompts, conventions |
| `test` | validation/convergence scripts whose point is to **confirm**, not discover |
| `chore` | housekeeping: cleanup, snapshot, data management, deps, env defaults |
| `revert` | undo a prior commit/change |
| `build` / `ci` / `style` | build system / CI / pure formatting |

### 3b. Extension types (Conventional-Commits-permitted "other types")

| type | use when… | pure-CC fallback |
|---|---|---|
| `diag` | the commit **records an investigation result** — root-cause, disproof, pinpoint, reframe, measured diagnosis — *code may be unchanged*. Typically the **largest category** in a research log. | `docs` (or `test`) |
| `exp` | the commit **launches/continues/records a compute run** — the run *is* the artifact (run-id, scale, params), outcome judged later | `chore` (or `test`/`ci`) |
| `infra` | the commit **changes the methodology/pipeline itself** — shared modules, hooks, schemas, the loop gate, this template/gate | `chore` (or `build`/`ci`) |
| `notes` | the commit **records a methodology note/decision** that is not a figure result — a proof sketch, convention, or design record | `docs` |

> Folding `diag`/`exp` into `docs`/`chore` would destroy the separability the taxonomy
> exists to provide — in a typical research log they are a majority of commits.

### 3c. Decision tree (gives every commit exactly one primary type → separability)

```
Did it change code/artifacts that affect output?
├─ yes ─ Was it correcting wrong behavior?            → fix      (perf if only speed)
│        Was it new capability / figure / data?       → feat
│        Was it pure restructuring (no behavior Δ)?   → refactor
│        Was it undoing a prior change?               → revert
│        Was it methodology/pipeline plumbing?        → infra
│        Was it other housekeeping (cleanup/          → chore
│            snapshot/data/deps/env defaults)?
│        Was it documentation text only?              → docs
└─ no  ─ Did it launch/continue/record a compute run? → exp
         Did it record a finding/claim (root-cause,   → diag
            disproof, measurement, reframe)?
         Was it a methodology note/decision?          → notes
         Otherwise (status note, checkpoint, tracker,
            self-prompt, plan)                         → docs   (scope: checkpoint / wip / tracker)
```

**Tie-break for mixed commits** (e.g. "found root cause **and** launched a test"):
choose the type of the **most consequential** action, ranked
`fix/feat > diag > exp > infra/docs/chore`. Put the secondary action in a body object
(`- next: …` for a launched run, `- change: …` for an incidental edit).

---

## 4. Scope vocabulary (controlled, extensible — name your own)

Scope is **optional** but strongly recommended — it is the second axis of separability.
Pick the narrowest that fits; combine with commas. Illustrative categories:

- **Figures / deliverables:** the consumer repo's figure or artifact ids (e.g. `fig6`, `table2`).
- **Pipeline stages / subsystems:** the module or stage touched (e.g. `source`, `solver`, `render`).
- **Packages:** an upstream/library name the change is scoped to.
- **Repo / process:** `repo` `data` `deps` `infra` `ledger` `checkpoint` `wip` `tracker`.

---

## 5. Body = a list of typed objects

The body is a blank line, then a **markdown list**. **Each list item is one object**:

```
- <kind>: <one-line gist>   [optional CLAIM-TAG]
  <optional continuation / nested bullets / numbered sub-list>
```

### 5a. Object-kind enum (fixed)

| kind | meaning |
|---|---|
| `why` | the trigger: user directive (quote it), a prior result, or idle-compute rationale |
| `finding` | a **typed claim** from investigation: root-cause / disproof / measurement / reframe. **Tag it** (§7). |
| `change` | a concrete edit: bug fixed (`file:line`), script/solver added, default/config changed, data committed/deleted, a revert |
| `run` | a compute job: `run-id`, scale (cores / batches / precision), params, and failure mode if any |
| `result` | outcome with **quantitative** evidence (numbers, residuals, ratios). **Tag it** (§7). |
| `verify` | how it was checked + evidence modality + verdict: `VLM <png>` / `subagent <id>` / `probe <path>` / `residual <x>` / `convergence` / `TRF-R` |
| `caveat` | honest limitation, open hole, compute-limit, `[FUTURE]` work |
| `next` | planned next step / in-progress / queued / awaiting steer |
| `files` | files added / changed / removed |

Formatting rules:
- One object per top-level `- ` item; **do not** merge two kinds into one line.
- Sub-structure (numbered `1. 2. 3.`, `BUG 1 … BUG 2 …`) goes as **nested bullets/numbers
  under a single** `- finding:`/`- change:` item.
- Order: roughly `why → finding → change → run → result → verify → caveat → next → files`
  (skip any you don't need). A guide, not a hard sort.

A subject-only commit (no body) is valid for any type — common for `exp`, short `diag`,
and `docs(checkpoint)`. Rough per-type profiles: `feat` → change+result+verify+files;
`fix` → finding(root-cause)+change(file:line)+verify; `diag` → finding(s)+verify;
`exp` → run(s); `chore`/`infra` → change(files).

---

## 6. Footers (git trailers — `Token: value`, one per line)

| footer | meaning | repeatable |
|---|---|---|
| `Iter: 316d` / `Window: 12` | iteration / window marker (the lab-notebook chronology) | no (use one) |
| `Run: <id> — <desc>` | background job id + what it computes | **yes** |
| `Refs: <file:line; eq:…; paper l.NNN>` | code / paper anchors | yes |
| `Verify: <evidence>` | verification artifact (paste the proof source) | **yes** |
| `Claim: <LEVEL> — <gist>; Modality: <…>` | typed-claim summary (§7) | yes |
| `BREAKING CHANGE: <…>` | what prior result/default is invalidated (§8) | yes |

---

## 7. Claim & evidence tags (typed-claim discipline)

Attach a tag to every `finding` and `result` object, and optionally summarize in a
`Claim:` footer. The vocabulary is shared with the markers contract of the Chandra
methodology.

**Claim level:**
- `[SOLID]` — verified, reproducible, defensible.
- `[PRELIMINARY]` — indicative, not yet confirmed (single point, partial run).
- `[HOLE]` — known gap / unresolved normalization / missing piece.
- `[FUTURE]` — explicitly deferred work.

**Evidence modality** (name it in `verify` / `Claim:`): `NumericalSimulation`,
`VLM` (visual figure match), `Analytic`/`Probe`, `Convergence`, `CrossCheck` (reference
code or package), `subagent`.

Example: `- result: |δe/e_0| ∈ paper colorbar 0..0.9 [SOLID]` with footer
`Claim: SOLID — morphology + spin-sequence; Modality: NumericalSimulation+VLM`.

---

## 8. The `!` / BREAKING CHANGE rule (result-invalidating changes)

Use `type!:` **only** when the commit **overturns a previously committed claim/result**
or **changes a default that changes published output**. Always pair with a
`BREAKING CHANGE:` footer naming exactly what is now invalid. Typical triggers:

- a **disproof/reframe** that kills a prior approach → `diag(figN)!`.
- a **bug whose fix invalidates earlier figures** → `fix(figN,driver)!`.
- a **resolution that rejects a proposed/landed fix** → `diag(scope)!`.

---

## 9. Worked examples (generic)

### 9a. `fix` with body

```
fix(fig6,source): stop double-raising the force index in the projection

- finding: root cause = prj·(gⁱ·f) instead of prj·f (index raised twice) [SOLID]
- change: source.jl:109 + fluid.jl:50 → prj·f
- verify: audit-confirmed, 2e-17 match, constant Δarg
- next: verify the spiral vs the published figure

Iter: 287
Refs: source.jl:109; fluid.jl:50
Verify: audit 2e-17 match (constant Δarg)
```

### 9b. Breaking `diag!` — disproof / escalation

```
diag(fig6)!: disprove the excision premise — genuine wall, escalate to user

- finding: indicial roots {0,2} are regular ⇒ the blowup is solver stiffness, not a singular solution [SOLID]
- finding: the exact figure needs the paper's analytic regular-singular solver (unpublished); approaches now exhausted
- next: escalate the go/no-go decision to the user

Iter: 300
BREAKING CHANGE: overturns the excision-based approach pursued in the prior iterations
```

---

## 10. Separability (why the taxonomy holds)

The decision tree (§3c) is **total** — every commit resolves to exactly one primary type
(mixed commits broken by the tie-break, secondary action moved to a body object), so any
tool can bucket the whole history by `type`/`scope` with the §11 parser.

---

## 11. Machine parsing & enabling the template

**Title parser** (POSIX-ERE; `type` and `scope` are captured for separability):

```
^(feat|fix|perf|refactor|docs|test|build|ci|style|revert|diag|exp|chore|infra|notes)(\(([^)]+)\))?(!)?: .+$
```

```bash
# bucket the working set of commits by type:
git log --format='%s' | sed -E 's/^([a-z]+)(\([^)]*\))?!?:.*/\1/' | sort | uniq -c | sort -rn
```

**Body objects** parse as `^- (why|finding|change|run|result|verify|caveat|next|files): `; **footers** as git trailers `^[A-Z][A-Za-z-]+: ` (`Iter:`, `Run:`, `Refs:`, `Verify:`, `Claim:`, `BREAKING CHANGE:`).

**Enforced — the commit-msg gate.** This template is wired into git as a tracked hook:

```bash
scripts/install-hooks.sh   # sets core.hooksPath=.githooks for this clone
```

- `.githooks/commit-msg` runs on every `git commit`: it **rejects** any title that
  fails the regex above (the separability requirement) and **warns** on body / footer /
  claim-tag issues (§12). `COMMIT_GATE_STRICT=1` turns the warnings into hard errors;
  `git commit --no-verify` bypasses once.
- Self-hosted on §0: `python3 -m pytest tests/test_commit_msg_gate.py`.

---

## 12. Pre-commit checklist

- [ ] Title is `type(scope)[!]: imperative summary`, type in column 1, ≤ ~72 chars, no period.
- [ ] Exactly one **primary** type (decision tree §3c); secondary action is a body object.
- [ ] Body (if any) is a **list of `- kind:` objects** from the §5 enum — no merged lines.
- [ ] Every `finding`/`result` carries a **claim tag** `[SOLID|PRELIMINARY|HOLE|FUTURE]`.
- [ ] Verification is real and pasted/anchored (`verify:` object and/or `Verify:` footer) — **no completion claim without it**.
- [ ] Iteration marker is in the `Iter:`/`Window:` footer, not the title.
- [ ] `!` + `BREAKING CHANGE:` present **iff** the commit invalidates a prior result/default (§8).
