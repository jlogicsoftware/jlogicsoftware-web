#!/usr/bin/env python3
"""Block a git commit that would land on a protected branch or carry a
malformed message.

Two rules live here, both of which the transcripts show being broken
repeatedly while written down in prose:

  1. a commit subject is at most 50 characters -- a model cannot count
     characters, so the count has to happen outside the model;
  2. a commit never lands on `main`.

Runs two ways:

  * as a Claude Code PreToolUse hook on Bash -- reads the hook JSON on
    stdin, exits 2 to block, and puts the reason on stderr, which is fed
    back as the blocking reason;
  * as a git `commit-msg` / `pre-commit` hook -- so the same rules apply to
    commits made outside a Claude session.

Rules are read from .claude/hooks/commit-rules.json; see DEFAULTS below.
"""

from __future__ import annotations

import json
import os
import re
import shlex
import subprocess
import sys

DEFAULTS = {
    "subject_max": 50,
    "protected_branches": ["main", "master"],
    # A regex the subject must match, or null to enforce shape only.
    "subject_pattern": None,
    "subject_pattern_hint": "",
}

# Message sources that leave the existing message untouched, so there is
# nothing for us to lint.
REUSE_FLAGS = {"--no-edit", "-C", "--reuse-message", "--fixup", "--squash", "--amend"}


def load_rules(root: str) -> dict:
    rules = dict(DEFAULTS)
    path = os.path.join(root, ".claude", "hooks", "commit-rules.json")
    try:
        with open(path, encoding="utf-8") as fh:
            rules.update(json.load(fh))
    except FileNotFoundError:
        pass
    except (OSError, ValueError) as exc:
        # A broken config must not silently disable the guard.
        print(f"commit-rules.json is unreadable ({exc}); using defaults.", file=sys.stderr)
    return rules


# --------------------------------------------------------------------------
# shell parsing
# --------------------------------------------------------------------------

HEREDOC_START = re.compile(r"<<-?\s*(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\1")


def extract_heredocs(command: str) -> tuple[str, list[str]]:
    """Pull heredoc bodies out of `command`.

    Returns the command with the bodies removed and the bodies in order.
    Bodies are removed before tokenizing because they hold arbitrary text --
    including `&&` and quotes -- that would otherwise wreck the split.
    """
    bodies: list[str] = []
    lines = command.split("\n")
    kept: list[str] = []
    i = 0
    while i < len(lines):
        line = lines[i]
        kept.append(line)
        tags = [m.group(2) for m in HEREDOC_START.finditer(line)]
        i += 1
        for tag in tags:
            body: list[str] = []
            while i < len(lines) and lines[i].strip() != tag:
                body.append(lines[i])
                i += 1
            i += 1  # skip the terminator
            bodies.append("\n".join(body))
    return "\n".join(kept), bodies


SPLIT = re.compile(r"&&|\|\||;|\n|(?<!\|)\|(?!\|)")


def git_subcommands(command: str) -> list[list[str]]:
    """Return the argv of every `git` invocation in a compound command."""
    stripped, _ = extract_heredocs(command)
    found: list[list[str]] = []
    for segment in SPLIT.split(stripped):
        segment = segment.strip()
        if not segment:
            continue
        try:
            tokens = shlex.split(segment, comments=True)
        except ValueError:
            # Unbalanced quotes -- fall back to a whitespace split rather than
            # giving up, so a quoting oddity cannot slip a commit past us.
            tokens = segment.split()
        # Step over a leading `env FOO=bar`, `sudo`, or `VAR=value` prefix.
        idx = 0
        while idx < len(tokens) and (
            tokens[idx] in ("env", "sudo", "command", "nohup") or "=" in tokens[idx].split(" ")[0]
        ):
            if tokens[idx] not in ("env", "sudo", "command", "nohup") and "=" not in tokens[idx]:
                break
            idx += 1
        if idx < len(tokens) and os.path.basename(tokens[idx]) == "git":
            found.append(tokens[idx:])
    return found


def subcommand_name(argv: list[str]) -> str | None:
    """The git subcommand, skipping global options like -C <path>."""
    i = 1
    while i < len(argv):
        tok = argv[i]
        if tok in ("-C", "-c", "--git-dir", "--work-tree", "--namespace"):
            i += 2
            continue
        if tok.startswith("-"):
            i += 1
            continue
        return tok
    return None


def message_from_argv(argv: list[str], heredocs: list[str], cwd: str) -> tuple[str | None, str | None]:
    """Recover the commit message. Returns (message, reason_it_is_absent)."""
    i = 0
    while i < len(argv):
        tok = argv[i]
        nxt = argv[i + 1] if i + 1 < len(argv) else None

        if tok.startswith("--message="):
            return tok.split("=", 1)[1], None
        if tok.startswith("--file="):
            return read_message_file(tok.split("=", 1)[1], heredocs, cwd)
        # -m, and combined short flags ending in m (-am, -qm, ...)
        if re.fullmatch(r"-[A-Za-z]*m", tok) and nxt is not None:
            return nxt, None
        if re.fullmatch(r"-[A-Za-z]*F", tok) and nxt is not None:
            return read_message_file(nxt, heredocs, cwd)
        if tok in REUSE_FLAGS or tok.startswith("--fixup=") or tok.startswith("--squash="):
            # --amend alone still opens an editor; --amend -m is caught above.
            if tok == "--amend":
                i += 1
                continue
            return None, "reuse"
        i += 1
    return None, "none"


def has_backstop(cwd: str) -> bool:
    """True if .git/hooks/commit-msg will lint the message we cannot read."""
    root = repo_root(cwd)
    if not root:
        return False
    hook = os.path.join(root, ".git", "hooks", "commit-msg")
    return os.path.isfile(hook) and os.access(hook, os.X_OK)


def read_message_file(path: str, heredocs: list[str], cwd: str) -> tuple[str | None, str | None]:
    if path == "-":
        if heredocs:
            return heredocs[0], None
        return None, "stdin"
    # The hook sees the command before the shell expands it, so a path built
    # from a variable or a substitution cannot be resolved here.
    if any(ch in path for ch in "$`*?"):
        return None, "unexpanded"
    full = path if os.path.isabs(path) else os.path.join(cwd, path)
    try:
        with open(full, encoding="utf-8") as fh:
            return fh.read(), None
    except OSError:
        return None, "unreadable"


# --------------------------------------------------------------------------
# the rules
# --------------------------------------------------------------------------


def check_message(message: str, rules: dict) -> list[str]:
    lines = message.replace("\r\n", "\n").split("\n")
    # git strips comment lines and trailing blank lines before storing.
    body_lines = [ln for ln in lines if not ln.startswith("#")]
    while body_lines and not body_lines[-1].strip():
        body_lines.pop()
    if not body_lines or not body_lines[0].strip():
        return ["The commit message is empty."]

    subject = body_lines[0].rstrip()
    # git writes these itself during merge, revert and rebase; their wording
    # is not the author's to shorten, so none of the rules below apply.
    if subject.startswith(("Merge ", "Revert ", "fixup! ", "squash! ")):
        return []

    problems: list[str] = []
    limit = int(rules["subject_max"])

    if len(subject) > limit:
        over = len(subject) - limit
        problems.append(
            f"Subject is {len(subject)} characters, {over} over the {limit} limit:\n"
            f"    {subject}\n"
            f"    {'-' * limit}^ the limit is here\n"
            "Shorten the subject and move the detail into the body."
        )
    if subject.endswith("."):
        problems.append("Subject must not end with a period.")
    if subject != subject.strip():
        problems.append("Subject has leading or trailing whitespace.")
    if len(body_lines) > 1 and body_lines[1].strip():
        problems.append("Line 2 must be blank -- a subject, then a blank line, then the body.")

    pattern = rules.get("subject_pattern")
    if pattern and not re.match(pattern, subject):
        hint = rules.get("subject_pattern_hint") or pattern
        problems.append(f"Subject does not match this repo's convention: {hint}")
    return problems


def merge_in_progress(cwd: str) -> bool:
    """True during a merge, revert or cherry-pick, when git supplies the message."""
    root = repo_root(cwd)
    if not root:
        return False
    git_dir = os.path.join(root, ".git")
    return any(
        os.path.exists(os.path.join(git_dir, name))
        for name in ("MERGE_HEAD", "MERGE_MSG", "REVERT_HEAD", "CHERRY_PICK_HEAD")
    )


def current_branch(cwd: str) -> str | None:
    try:
        out = subprocess.run(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            cwd=cwd, capture_output=True, text=True, timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return out.stdout.strip() if out.returncode == 0 else None


def creates_branch(command: str) -> bool:
    """True if the same command switches to a new branch before committing."""
    for argv in git_subcommands(command):
        name = subcommand_name(argv)
        if name == "checkout" and any(re.fullmatch(r"-[bB]", t) for t in argv):
            return True
        if name == "switch" and any(t in ("-c", "-C", "--create") for t in argv):
            return True
    return False


# --------------------------------------------------------------------------
# entry points
# --------------------------------------------------------------------------


def run_as_claude_hook() -> int:
    try:
        payload = json.load(sys.stdin)
    except (ValueError, OSError):
        return 0  # never break the session over a malformed payload

    command = (payload.get("tool_input") or {}).get("command") or ""
    cwd = payload.get("cwd") or os.getcwd()
    if not command.strip():
        return 0

    invocations = git_subcommands(command)
    names = [subcommand_name(a) for a in invocations]
    if "commit" not in names and "push" not in names:
        return 0

    root = repo_root(cwd) or cwd
    rules = load_rules(root)
    _, heredocs = extract_heredocs(command)
    problems: list[str] = []

    branch = current_branch(cwd)
    protected = rules["protected_branches"]
    if branch in protected and not creates_branch(command):
        verb = "commit" if "commit" in names else "push"
        problems.append(
            f"HEAD is `{branch}`, which is protected, and this command would {verb} onto it.\n"
            f"Run `git checkout -b <type>/<slug>` first, in its own step, then re-issue this."
        )

    for argv, name in zip(invocations, names):
        if name != "commit":
            continue
        message, absent = message_from_argv(argv, heredocs, cwd)
        if message is not None:
            problems.extend(check_message(message, rules))
        elif absent == "none":
            if merge_in_progress(cwd):
                continue  # git has prepared MERGE_MSG; nothing to lint
            problems.append(
                "This commit has no message on the command line, so it would open an\n"
                "editor and hang. Pass the message with -m, or write it to a file and\n"
                "use `git commit -F <file>`."
            )
        elif absent in ("stdin", "unreadable", "unexpanded"):
            if has_backstop(cwd):
                continue  # .git/hooks/commit-msg lints the real message
            problems.append(
                "The commit message cannot be read here, so its subject length cannot\n"
                "be checked, and .git/hooks/commit-msg is not installed to catch it\n"
                "either. Either run `sh .claude/hooks/install-git-hooks.sh`, or pass\n"
                "the message with a literal path: `git commit -F <path>` (no shell\n"
                "variables -- this hook sees the command before the shell expands it)."
            )

    if not problems:
        return 0
    print("Blocked by the git guard (.claude/hooks/git_guard.py):\n", file=sys.stderr)
    for problem in problems:
        print(f"  - {problem}\n", file=sys.stderr)
    return 2


def repo_root(cwd: str) -> str | None:
    try:
        out = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            cwd=cwd, capture_output=True, text=True, timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return out.stdout.strip() if out.returncode == 0 else None


def run_as_commit_msg(path: str) -> int:
    root = repo_root(os.getcwd()) or os.getcwd()
    try:
        with open(path, encoding="utf-8") as fh:
            message = fh.read()
    except OSError as exc:
        print(f"commit-msg hook could not read {path}: {exc}", file=sys.stderr)
        return 1
    problems = check_message(message, load_rules(root))
    if not problems:
        return 0
    print("\nCommit rejected by .git/hooks/commit-msg:\n", file=sys.stderr)
    for problem in problems:
        print(f"  - {problem}\n", file=sys.stderr)
    return 1


def run_as_pre_commit() -> int:
    root = repo_root(os.getcwd()) or os.getcwd()
    rules = load_rules(root)
    branch = current_branch(os.getcwd())
    if branch in rules["protected_branches"]:
        print(
            f"\nCommit rejected by .git/hooks/pre-commit: HEAD is `{branch}`.\n"
            f"  Create a branch first:  git checkout -b <type>/<slug>\n"
            f"  Deliberate override:    git commit --no-verify\n",
            file=sys.stderr,
        )
        return 1
    return 0


def main() -> int:
    mode = sys.argv[1] if len(sys.argv) > 1 else "claude-hook"
    if mode == "commit-msg":
        return run_as_commit_msg(sys.argv[2])
    if mode == "pre-commit":
        return run_as_pre_commit()
    return run_as_claude_hook()


if __name__ == "__main__":
    sys.exit(main())
