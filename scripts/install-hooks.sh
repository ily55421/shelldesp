#!/bin/sh
# ShellDesk: install git hooks
# Usage: sh scripts/install-hooks.sh
cp scripts/pre-commit .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit 2>/dev/null
echo "✅ pre-commit hook installed"
