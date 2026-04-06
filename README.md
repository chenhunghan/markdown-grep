# mdg — Markdown Grep

Search markdown files with grep-like syntax and hybrid semantic ranking.

To install the latest release binary:

```bash
curl -fsSL https://raw.githubusercontent.com/chenhunghan/markdown-grep/main/install.sh | bash
```

Re-running the script is safe; it updates `mdg` to the latest GitHub release if needed.

On Windows, use PowerShell:

```powershell
iwr https://raw.githubusercontent.com/chenhunghan/markdown-grep/main/install.ps1 | iex
```

## Setup

Zero setup for `mdg grep`.
Semantic search engines auto-installs on first use.

```bash
# Pre-install optional semantic search dependencies
mdg setup
```

## Usage

```bash
# Search by meaning, not exact text
mdg grep "how to configure the API"
mdg grep "error handling patterns" docs/

# Combine with grep flags for output formatting
mdg grep -nl "authentication flow"

# Recursive search with line numbers
mdg grep -rn "pattern" [path...]

# Case-insensitive, list matching files only
mdg grep -rli "pattern"

# Count matches per file
mdg grep -rc "pattern" docs/

# All standard grep flags work (-v, -w, -x, -A, -B, -C, --include, etc.)
mdg grep -rn -A 2 -B 1 "function" .
```

### Optional Indexing

Indexes are updated automatically in the background on every search. Optionally you can index manually.

```bash
# Build/update the search index (FTS + embeddings)
mdg index

# Force re-index everything
mdg index --force

# Check index status
mdg status
```


