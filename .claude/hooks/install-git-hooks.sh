#!/bin/sh
# Install the repository-level git hooks.
#
# .git/hooks is not tracked, so a fresh clone has no guard until this runs.
# The Claude Code hooks in .claude/settings.json ARE tracked and need no
# install step; these cover commits made outside a Claude session.
set -eu
root=$(git rev-parse --show-toplevel)
cd "$root"

for hook in pre-commit commit-msg; do
    case $hook in
        pre-commit) mode=pre-commit; note="Refuse a commit on a protected branch." ;;
        commit-msg) mode='commit-msg "$1"'; note="Lint the commit subject." ;;
    esac
    cat > ".git/hooks/$hook" <<HOOK
#!/bin/sh
# $note See .claude/hooks/git_guard.py.
exec python3 "\$(git rev-parse --show-toplevel)/.claude/hooks/git_guard.py" $mode
HOOK
    chmod +x ".git/hooks/$hook"
    echo "installed .git/hooks/$hook"
done

git config commit.template .gitmessage
echo "set commit.template to .gitmessage"
echo
echo "Verify with: python3 .claude/hooks/test_git_guard.py"
