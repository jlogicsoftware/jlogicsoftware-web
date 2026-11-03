#!/usr/bin/env python3
"""Tests for git_guard.py. Run: python3 test_git_guard.py"""
import json, os, subprocess, sys, tempfile, textwrap

HERE = os.path.dirname(os.path.abspath(__file__))
GUARD = os.path.join(HERE, "git_guard.py")

sys.path.insert(0, HERE)
import git_guard as g  # noqa: E402

FAILURES = []

def check(name, cond, detail=""):
    if cond:
        print(f"  ok   {name}")
    else:
        print(f"  FAIL {name} {detail}")
        FAILURES.append(name)

# ---------------------------------------------------------------- parsing
print("parsing")
check("plain commit found",
      [g.subcommand_name(a) for a in g.git_subcommands('git commit -m "x"')] == ["commit"])
check("compound command found",
      "commit" in [g.subcommand_name(a) for a in g.git_subcommands('git add -A && git commit -m "x"')])
check("cd prefix segment ignored, commit still found",
      "commit" in [g.subcommand_name(a) for a in g.git_subcommands('cd /tmp && git commit -m "x"')])
check("git -C <path> commit resolves subcommand",
      g.subcommand_name(g.git_subcommands('git -C /tmp commit -m "x"')[0]) == "commit")
check("non-git command ignored",
      g.git_subcommands('echo "git commit -m nope"') == [])
check("push detected",
      "push" in [g.subcommand_name(a) for a in g.git_subcommands("git push origin HEAD")])

_, bodies = g.extract_heredocs("git commit -q -F - <<'EOF'\nsubject here\n\nbody\nEOF")
check("heredoc body extracted", bodies == ["subject here\n\nbody"], repr(bodies))
_, b2 = g.extract_heredocs('git commit -F - <<MSG\na && b\nMSG\ngit push')
check("heredoc body with && does not split", b2 == ["a && b"], repr(b2))

# ------------------------------------------------------------- extraction
print("message extraction")
def msg(cmd, cwd="/tmp"):
    _, hd = g.extract_heredocs(cmd)
    argv = [a for a in g.git_subcommands(cmd) if g.subcommand_name(a) == "commit"][0]
    return g.message_from_argv(argv, hd, cwd)

check("-m", msg('git commit -m "hello there"') == ("hello there", None))
check("--message=", msg('git commit --message=hello') == ("hello", None))
check("-am combined flag", msg('git commit -am "hello"') == ("hello", None))
check("-qm combined flag", msg('git commit -qm "hello"') == ("hello", None))
check("-F - heredoc", msg("git commit -q -F - <<'EOF'\nsubject\nEOF") == ("subject", None))
check("--amend --no-edit reuses", msg("git commit --amend --no-edit")[1] == "reuse")
check("bare commit has no message", msg("git commit")[1] == "none")

with tempfile.TemporaryDirectory() as td:
    p = os.path.join(td, "msg.txt")
    open(p, "w").write("from a file\n\nbody\n")
    check("-F <file> absolute", msg(f"git commit -F {p}") == ("from a file\n\nbody\n", None))
    check("-F <file> relative to cwd", msg("git commit -F msg.txt", cwd=td)[0].startswith("from a file"))

# ------------------------------------------------------------------ rules
print("message rules")
R = dict(g.DEFAULTS)
check("50 chars passes", g.check_message("a" * 50, R) == [])
check("51 chars fails", any("51 characters" in p for p in g.check_message("a" * 51, R)))
check("108-char real subject fails",
      g.check_message("docs: style READMEs with DartZen's badge/emoji conventions, refresh cold-start numbers, add a comparison", R) != [])
check("trailing period fails", any("period" in p for p in g.check_message("Fix the thing.", R)))
check("non-blank line 2 fails", any("Line 2" in p for p in g.check_message("Subject\nbody now", R)))
check("blank line 2 passes", g.check_message("Subject\n\nbody now", R) == [])
check("empty message fails", g.check_message("\n\n", R) != [])
check("comment lines ignored", g.check_message("Subject\n\nbody\n# comment\n", R) == [])
cyr = "Виправлено відображення імені у таблиці лідерів"
check("cyrillic subject of 50 chars passes (chars, not bytes)",
      len(cyr) <= 50 and len(cyr.encode()) > 50 and g.check_message(cyr, R) == [],
      "chars=%d bytes=%d" % (len(cyr), len(cyr.encode())))
check("cyrillic subject over 50 chars fails",
      any("characters" in x for x in g.check_message(cyr + "ааааа", R)))

check("subject_pattern enforced when set",
      any("convention" in p for p in g.check_message(
          "Fix the thing", {**R, "subject_pattern": r"^(feat|fix|docs)(\(.+\))?: ", "subject_pattern_hint": "feat(scope): ..."})))
check("subject_pattern satisfied",
      g.check_message("fix(course): stop the overflow",
                      {**R, "subject_pattern": r"^(feat|fix|docs)(\(.+\))?: "}) == [])

print("branch creation")
check("checkout -b in same command counts", g.creates_branch("git checkout -b x/y && git commit -m z"))
check("switch -c in same command counts", g.creates_branch("git switch -c x/y && git commit -m z"))
check("plain checkout does not count", not g.creates_branch("git checkout main && git commit -m z"))

# ------------------------------------------------------- end-to-end hook
print("end-to-end (real git repo)")
def run_hook(cmd, cwd):
    payload = {"hook_event_name": "PreToolUse", "tool_name": "Bash",
               "cwd": cwd, "tool_input": {"command": cmd}}
    p = subprocess.run([sys.executable, GUARD], input=json.dumps(payload),
                       capture_output=True, text=True)
    return p.returncode, p.stderr

with tempfile.TemporaryDirectory() as repo:
    q = dict(capture_output=True, cwd=repo, text=True)
    subprocess.run(["git", "init", "-q", "-b", "main", repo], capture_output=True)
    subprocess.run(["git", "config", "user.email", "t@t"], **q)
    subprocess.run(["git", "config", "user.name", "t"], **q)
    open(os.path.join(repo, "f.txt"), "w").write("x")
    subprocess.run(["git", "add", "-A"], **q)
    subprocess.run(["git", "commit", "-qm", "init"], **q)
    os.makedirs(os.path.join(repo, ".claude", "hooks"), exist_ok=True)

    rc, err = run_hook('git commit -m "short subject"', repo)
    check("blocks commit on main", rc == 2 and "protected" in err, err[:120])

    rc, err = run_hook('echo hello', repo)
    check("ignores unrelated command", rc == 0)

    rc, err = run_hook('git status', repo)
    check("ignores git status", rc == 0)

    rc, err = run_hook('git checkout -b feat/x && git commit -m "short subject"', repo)
    check("allows commit when branch created in same command", rc == 0, err[:200])

    subprocess.run(["git", "checkout", "-qb", "feat/x"], **q)
    rc, err = run_hook('git commit -m "short subject"', repo)
    check("allows good commit off main", rc == 0, err[:200])

    rc, err = run_hook('git commit -m "%s"' % ("a" * 60), repo)
    check("blocks 60-char subject off main", rc == 2 and "60 characters" in err, err[:200])

    rc, err = run_hook('git push origin HEAD', repo)
    check("allows push off main", rc == 0)

    subprocess.run(["git", "checkout", "-q", "main"], **q)
    rc, err = run_hook('git push origin main', repo)
    check("blocks push on main", rc == 2 and "protected" in err, err[:120])

    # config is honoured
    open(os.path.join(repo, ".claude", "hooks", "commit-rules.json"), "w").write(
        json.dumps({"subject_max": 72, "protected_branches": []}))
    rc, err = run_hook('git commit -m "%s"' % ("a" * 60), repo)
    check("config raises the limit", rc == 0, err[:200])
    rc, err = run_hook('git commit -m "%s"' % ("a" * 80), repo)
    check("config still enforces new limit", rc == 2 and "80 characters" in err, err[:200])

    # a path the shell has not expanded yet
    hookdir = os.path.join(repo, ".git", "hooks")
    os.makedirs(hookdir, exist_ok=True)
    cm = os.path.join(hookdir, "commit-msg")
    rc, err = run_hook('git commit -F $SP/msg.txt', repo)
    check("no backstop: unexpanded path is blocked with guidance",
          rc == 2 and "install-git-hooks" in err, err[:200])
    open(cm, "w").write("#!/bin/sh\nexit 0\n"); os.chmod(cm, 0o755)
    rc, err = run_hook('git commit -F $SP/msg.txt', repo)
    check("backstop installed: defers to .git/hooks/commit-msg", rc == 0, err[:200])
    rc, err = run_hook('git commit -m "%s"' % ("a" * 80), repo)
    check("backstop does not weaken a message it CAN read",
          rc == 2 and "80 characters" in err, err[:200])
    # an earlier case set protected_branches to []; restore it for this check
    open(os.path.join(repo, ".claude", "hooks", "commit-rules.json"), "w").write(
        json.dumps({"subject_max": 72, "protected_branches": ["main"]}))
    subprocess.run(["git", "checkout", "-q", "main"], **q)
    rc, err = run_hook('git commit -F $SP/msg.txt', repo)
    check("backstop does not weaken the branch rule", rc == 2 and "protected" in err, err[:200])
    subprocess.run(["git", "checkout", "-q", "feat/x"], **q)
    open(os.path.join(repo, ".claude", "hooks", "commit-rules.json"), "w").write(
        json.dumps({"subject_max": 72, "protected_branches": []}))

    # merge in progress: a bare `git commit` is not a missing message
    subprocess.run(["git", "checkout", "-qb", "other"], **q)
    open(os.path.join(repo, "f.txt"), "w").write("y")
    subprocess.run(["git", "commit", "-qam", "Change on a side branch"], **q)
    subprocess.run(["git", "checkout", "-q", "feat/x"], **q)
    open(os.path.join(repo, ".git", "MERGE_MSG"), "w").write("Merge branch 'other'\n")
    open(os.path.join(repo, ".git", "MERGE_HEAD"), "w").write("deadbeef\n")
    rc, err = run_hook("git commit", repo)
    check("bare commit during a merge is allowed", rc == 0, err[:200])
    os.remove(os.path.join(repo, ".git", "MERGE_MSG"))
    os.remove(os.path.join(repo, ".git", "MERGE_HEAD"))
    rc, err = run_hook("git commit", repo)
    check("bare commit outside a merge is still blocked", rc == 2 and "editor" in err, err[:200])

    # generated subjects bypass the style pattern but not the length rule
    conv = {**R, "subject_pattern": r"^(feat|fix|docs)(\(.+\))?: "}
    check("merge subject exempt from style pattern",
          g.check_message("Merge pull request #12 from org/branch", conv) == [])
    check("revert subject exempt from style pattern",
          g.check_message('Revert "fix: the thing"', conv) == [])
    check("long merge subject is exempt (git wrote it, not the author)",
          g.check_message("Merge remote-tracking branch 'origin/main' into feat/git-foundations", conv) == [])
    check("fixup! subject exempt", g.check_message("fixup! " + "a" * 60, conv) == [])
    check("a normal long subject is still blocked",
          any("characters" in x for x in g.check_message("feat: " + "a" * 60, conv)))

    # commit-msg mode
    mp = os.path.join(repo, "m.txt")
    open(mp, "w").write("a" * 80)
    p = subprocess.run([sys.executable, GUARD, "commit-msg", mp], capture_output=True, text=True, cwd=repo)
    check("commit-msg mode rejects", p.returncode == 1 and "80 characters" in p.stderr, p.stderr[:120])

print()
if FAILURES:
    print(f"{len(FAILURES)} FAILED: {FAILURES}")
    sys.exit(1)
print("all tests passed")
