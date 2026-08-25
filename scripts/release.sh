#!/bin/bash
set -e
set -o pipefail

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# ---------------------------------------------------------------------------
# Args
# ---------------------------------------------------------------------------

TARGET_VERSION_HINT=""
RELEASE_SELECTOR=""
NON_INTERACTIVE=false
PUSH_MODE="prompt"
PUBLISH_MODE="ci"

print_usage() {
    echo "Usage: $0 [OPTIONS] [VERSION]"
    echo ""
    echo "Idempotent release script. Re-run the same command to continue after"
    echo "a failure; completed steps are skipped automatically."
    echo ""
    echo "Options:"
    echo "  VERSION           Continue or finish this version (optional hint)"
    echo "  --patch           Select the next patch release"
    echo "  --minor           Select the next minor release"
    echo "  --major           Select the next major release"
    echo "  --push            Push the release commit and tag without prompting"
    echo "  --no-push         Prepare the release locally without pushing"
    echo "  --non-interactive Do not prompt; requires --push or --no-push"
    echo "  --publish-local   Publish locally with pnpm instead of delegating to CI"
    echo "  --help, -h        Show this help"
    echo ""
    echo "Examples:"
    echo "  $0 --minor --push --non-interactive"
    echo "                     # Bump, changelog, commit, tag, and push"
    echo "  $0 1.2.3 --push --non-interactive"
    echo "                     # Continue/finish release 1.2.3 and push it"
    echo ""
    echo "By default npm publishing is delegated to the GitHub Actions Trusted"
    echo "Publishing workflow after the tag is pushed. Use --publish-local only"
    echo "for an explicit token-authenticated local publish fallback."
}

while [[ $# -gt 0 ]]; do
    case $1 in
        --resume)
            # Back-compat: formerly required for recovery. Now every run continues.
            echo -e "${YELLOW}Note: --resume is no longer needed; continuing automatically.${NC}"
            if [[ -n "${2:-}" && ! "$2" =~ ^-- ]]; then
                TARGET_VERSION_HINT="$2"
                shift
            fi
            shift
            ;;
        --patch|--minor|--major)
            if [[ -n "$RELEASE_SELECTOR" ]]; then
                echo -e "${RED}Only one of --patch, --minor, or --major may be specified.${NC}"
                print_usage
                exit 1
            fi
            RELEASE_SELECTOR="${1#--}"
            shift
            ;;
        --push)
            if [[ "$PUSH_MODE" == "skip" ]]; then
                echo -e "${RED}Specify only one of --push or --no-push.${NC}"
                print_usage
                exit 1
            fi
            PUSH_MODE="push"
            shift
            ;;
        --no-push)
            if [[ "$PUSH_MODE" == "push" ]]; then
                echo -e "${RED}Specify only one of --push or --no-push.${NC}"
                print_usage
                exit 1
            fi
            PUSH_MODE="skip"
            shift
            ;;
        --non-interactive|--yes)
            NON_INTERACTIVE=true
            shift
            ;;
        --publish-local)
            PUBLISH_MODE="local"
            shift
            ;;
        --help|-h)
            print_usage
            exit 0
            ;;
        -*)
            echo -e "${RED}Unknown option: $1${NC}"
            print_usage
            exit 1
            ;;
        *)
            if [[ -n "$TARGET_VERSION_HINT" ]]; then
                echo -e "${RED}Unexpected argument: $1${NC}"
                print_usage
                exit 1
            fi
            TARGET_VERSION_HINT="$1"
            shift
            ;;
    esac
done

if [[ -n "$TARGET_VERSION_HINT" && -n "$RELEASE_SELECTOR" ]]; then
    echo -e "${RED}Specify either VERSION or a release selector, not both.${NC}"
    print_usage
    exit 1
fi

if [[ "$NON_INTERACTIVE" == "true" && "$PUSH_MODE" == "prompt" ]]; then
    echo -e "${RED}--non-interactive requires either --push or --no-push.${NC}"
    print_usage
    exit 1
fi

echo -e "${BLUE}=== Release Script ===${NC}"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

tag_exists() {
    git rev-parse "v$1" >/dev/null 2>&1
}

changelog_has_version() {
    if [ -f CHANGELOG.md ]; then
        grep -q "## \[$1\]" CHANGELOG.md 2>/dev/null
    else
        return 1
    fi
}

release_commit_exists() {
    git log --oneline --grep="chore(release): v$1" -n 20 2>/dev/null | grep -q .
}

is_published_on_npm() {
    local pkg_name
    pkg_name=$(node -p "require('./package.json').name")
    pnpm view "${pkg_name}@$1" version >/dev/null 2>&1
}

get_changelog_top_version() {
    if [ ! -f CHANGELOG.md ]; then
        return 1
    fi
    local ver
    ver=$(grep -m1 '^## \[' CHANGELOG.md | sed -E 's/^## \[([0-9]+\.[0-9]+\.[0-9]+)\].*/\1/')
    if [[ "$ver" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        echo "$ver"
        return 0
    fi
    return 1
}

get_package_version() {
    node -p "require('./package.json').version"
}

get_latest_tag_version() {
    git describe --tags --abbrev=0 2>/dev/null | sed 's/^v//' || true
}

# Return 0 if $1 > $2 (semver sort). Empty $2 means $1 wins.
version_gt() {
    local higher
    if [[ -z "$2" ]]; then
        return 0
    fi
    higher=$(printf "%s\n%s" "$2" "$1" | sort -V | tail -1)
    [[ "$higher" == "$1" && "$1" != "$2" ]]
}

# Tracked dirty paths (unstaged + staged), one per line
dirty_tracked_files() {
    { git diff --name-only; git diff --name-only --cached; } | sort -u | sed '/^$/d'
}

file_is_dirty() {
    local f=$1
    if git diff --name-only -- "$f" | grep -q .; then
        return 0
    fi
    if git diff --name-only --cached -- "$f" | grep -q .; then
        return 0
    fi
    return 1
}

is_tag_on_remote() {
    local v=$1
    local remote
    remote=$(git remote 2>/dev/null | head -1)
    if [[ -z "$remote" ]]; then
        return 1
    fi
    git ls-remote --tags "$remote" "refs/tags/v${v}" 2>/dev/null | grep -q .
}

# Bounded retries for transient operations. Usage: retry ATTEMPTS DELAY_SECS -- cmd args...
# Progress messages go to stderr so command substitution captures only cmd stdout.
retry() {
    local attempts=$1
    local delay=$2
    shift 2
    if [[ "${1:-}" == "--" ]]; then
        shift
    fi
    local n=1
    local current_delay=$delay
    until "$@"; do
        if (( n >= attempts )); then
            return 1
        fi
        echo -e "${YELLOW}Attempt $n/$attempts failed; retrying in ${current_delay}s...${NC}" >&2
        sleep "$current_delay"
        current_delay=$((current_delay * 2))
        n=$((n + 1))
    done
}

push_release_refs() {
    local version=$1
    local remote
    remote=$(git remote 2>/dev/null | head -1)
    if [[ -z "$remote" ]]; then
        echo -e "${RED}No git remote is configured; cannot push release refs.${NC}"
        return 1
    fi

    # Push only the current branch and this release tag. The old `git push
    # --tags` form could publish unrelated local tags along with the release.
    retry 3 2 -- git push "$remote" HEAD
    retry 3 2 -- git push "$remote" "v$version"
}

run_health_checks() {
    echo -e "${BLUE}Running typecheck, source lint, formatting, tests, and build...${NC}"
    # Release validation covers the shipped source and release metadata. The
    # repository-wide lint command also traverses auxiliary tools that are not
    # part of the published package and can block an otherwise valid release.
    pnpm typecheck
    pnpm exec eslint source
    pnpm exec prettier --check source package.json CHANGELOG.md
    pnpm run build
    pnpm test
}

# ---------------------------------------------------------------------------
# Dirty worktree: only package.json + CHANGELOG.md allowed
# ---------------------------------------------------------------------------

DIRTY_FILES=$(dirty_tracked_files || true)
if [[ -n "$DIRTY_FILES" ]]; then
    while IFS= read -r f; do
        [[ -z "$f" ]] && continue
        case "$f" in
            package.json|CHANGELOG.md) ;;
            *)
                echo -e "${RED}Error: Working directory has unrelated changes. Only package.json and CHANGELOG.md may be dirty during a release.${NC}"
                git status -s
                exit 1
                ;;
        esac
    done <<< "$DIRTY_FILES"
fi

CURRENT_VERSION=$(get_package_version)
echo -e "Current version in package.json: ${YELLOW}$CURRENT_VERSION${NC}"

LATEST_TAG=$(get_latest_tag_version)
if [[ -n "$LATEST_TAG" ]]; then
    echo -e "Latest tag: ${YELLOW}v$LATEST_TAG${NC}"
fi

# ---------------------------------------------------------------------------
# Detect in-flight release vs start fresh
# ---------------------------------------------------------------------------

# True when local release work for this version is unfinished.
# Push/publish-only recovery is opt-in via explicit VERSION argument so a
# flaky npm/remote probe cannot trap the next release.
is_in_flight() {
    local v=$1

    # Uncommitted release files for this version
    if file_is_dirty package.json && [[ "$(get_package_version)" == "$v" ]]; then
        return 0
    fi
    if file_is_dirty CHANGELOG.md; then
        local top
        top=$(get_changelog_top_version || true)
        if [[ "$top" == "$v" ]]; then
            return 0
        fi
    fi

    # package.json already advanced past the latest tag (mid bump/commit/tag)
    if version_gt "$v" "$LATEST_TAG"; then
        return 0
    fi

    # Commit exists but tag does not
    if release_commit_exists "$v" && ! tag_exists "$v"; then
        return 0
    fi

    return 1
}

NEW_VERSION=""
CHANGELOG_DONE=false
VALIDATED=false

if [[ -n "$TARGET_VERSION_HINT" ]]; then
    NEW_VERSION="$TARGET_VERSION_HINT"
    echo -e "Target version (from argument): ${GREEN}$NEW_VERSION${NC}"
elif is_in_flight "$CURRENT_VERSION"; then
    NEW_VERSION="$CURRENT_VERSION"
    echo -e "${YELLOW}In-flight release detected for v$NEW_VERSION — continuing.${NC}"
else
    # Pre-written changelog for a not-yet-tagged next version?
    CHANGELOG_TOP=$(get_changelog_top_version || true)
    if [[ -n "$CHANGELOG_TOP" ]] \
        && ! tag_exists "$CHANGELOG_TOP" \
        && version_gt "$CHANGELOG_TOP" "$LATEST_TAG" \
        && changelog_has_version "$CHANGELOG_TOP"; then
        # package.json must be clean at the old version, or already at the new one
        if [[ "$CURRENT_VERSION" == "$CHANGELOG_TOP" ]] || ! file_is_dirty package.json; then
            if file_is_dirty CHANGELOG.md || ! release_commit_exists "$CHANGELOG_TOP"; then
                NEW_VERSION="$CHANGELOG_TOP"
                CHANGELOG_DONE=true
                echo -e "${GREEN}Using pre-written changelog for v$NEW_VERSION.${NC}"
            fi
        fi
    fi
fi

if [[ -z "$NEW_VERSION" ]]; then
    # Refuse to start a fresh release with a half-edited package.json
    if file_is_dirty package.json; then
        echo -e "${RED}Error: package.json is modified but no in-flight release matched version $CURRENT_VERSION.${NC}"
        echo -e "${RED}Commit/stash it, or pass the version explicitly: $0 <version>${NC}"
        exit 1
    fi

    run_health_checks
    VALIDATED=true

    if [[ -n "$RELEASE_SELECTOR" ]]; then
        pnpm version "$RELEASE_SELECTOR" --no-git-tag-version --no-commit-hooks >/dev/null
        NEW_VERSION=$(get_package_version)
    elif [[ "$NON_INTERACTIVE" == "true" ]]; then
        echo -e "${RED}Non-interactive mode needs --patch, --minor, --major, or VERSION.${NC}"
        exit 1
    else
        echo "Select release type:"
        options=("Patch" "Minor" "Major" "Custom")
        select opt in "${options[@]}"; do
            case $opt in
                "Patch")
                    pnpm version patch --no-git-tag-version --no-commit-hooks >/dev/null
                    NEW_VERSION=$(get_package_version)
                    break
                    ;;
                "Minor")
                    pnpm version minor --no-git-tag-version --no-commit-hooks >/dev/null
                    NEW_VERSION=$(get_package_version)
                    break
                    ;;
                "Major")
                    pnpm version major --no-git-tag-version --no-commit-hooks >/dev/null
                    NEW_VERSION=$(get_package_version)
                    break
                    ;;
                "Custom")
                    read -r -p "Enter version: " NEW_VERSION
                    pnpm version "$NEW_VERSION" --no-git-tag-version --no-commit-hooks >/dev/null
                    NEW_VERSION=$(get_package_version)
                    break
                    ;;
                *) echo "Invalid option";;
            esac
        done
    fi
fi

if [[ -z "$NEW_VERSION" ]]; then
    echo -e "${RED}Error: could not determine release version.${NC}"
    exit 1
fi

# Validate dirty files match the target version
if file_is_dirty package.json; then
    if [[ "$(get_package_version)" != "$NEW_VERSION" ]]; then
        echo -e "${RED}Error: package.json is dirty at version $(get_package_version), expected $NEW_VERSION.${NC}"
        exit 1
    fi
fi
if file_is_dirty CHANGELOG.md; then
    if ! changelog_has_version "$NEW_VERSION"; then
        echo -e "${RED}Error: CHANGELOG.md is dirty but has no ## [$NEW_VERSION] entry.${NC}"
        exit 1
    fi
fi

if changelog_has_version "$NEW_VERSION"; then
    CHANGELOG_DONE=true
fi

echo -e "Preparing release for version: ${GREEN}$NEW_VERSION${NC}"

# ---------------------------------------------------------------------------
# Changelog
# ---------------------------------------------------------------------------

if [[ "$CHANGELOG_DONE" == "true" ]]; then
    echo -e "${YELLOW}Skipping changelog generation (already has v$NEW_VERSION entry)${NC}"
else
    echo -e "${BLUE}Generating changelog with term2...${NC}"

    LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")

    if [ -z "$LAST_TAG" ]; then
        echo "No previous tags found. Using all commits."
        COMMITS=$(git log --pretty=format:"- %s (%h) by %an")
    else
        echo "Using commits since $LAST_TAG"
        COMMITS=$(git log "${LAST_TAG}"..HEAD --pretty=format:"- %s (%h) by %an")
    fi

    if [ -z "$COMMITS" ]; then
        echo -e "${YELLOW}No commits found. Skipping changelog body generation.${NC}"
        CHANGELOG_ENTRY="## [$NEW_VERSION] - $(date +%Y-%m-%d)"
    else
        PROMPT="Generate a concise user-oriented CHANGELOG.md entry for version $NEW_VERSION.
        Group changes into sections: Features, Bug Fixes, Improvements.
        Do not list internal changes that end-user does not need to know.
        If a bug-fix is for a feature that newly added in this same release, do not mention them.
        Here are the commits:
        $COMMITS

        Format as Markdown. Do not include a main title like 'Changelog', just the version header and sections.
        CRITICAL: Output ONLY the raw markdown content. Do NOT wrap in markdown code blocks (e.g., no \`\`\`markdown). Do not include any introductory or concluding remarks.
        Example format:
        ## [1.2.3] - 2023-01-01

        ### Features
        - ...
        "

        generate_changelog() {
            term2 -l -m gpt-5.4-mini -p openai "$PROMPT" 2>/dev/null \
                | sed -E '/^ *```/d' \
                | sed -E 's/<\!--.*-->//g'
        }

        # Retry without mixing failed-attempt stdout into the captured entry.
        CHANGELOG_ENTRY=""
        changelog_ok=false
        for changelog_attempt in 1 2 3; do
            if CHANGELOG_ENTRY=$(generate_changelog) \
                && [[ -n "$CHANGELOG_ENTRY" ]] \
                && echo "$CHANGELOG_ENTRY" | grep -q "## \[$NEW_VERSION\]"; then
                changelog_ok=true
                break
            fi
            if [[ "$changelog_attempt" -lt 3 ]]; then
                echo -e "${YELLOW}Changelog generation attempt $changelog_attempt failed; retrying...${NC}"
                sleep $((changelog_attempt * 2))
            fi
        done
        if [[ "$changelog_ok" != "true" ]]; then
            echo -e "${RED}Error: Failed to generate changelog with term2 after retries.${NC}"
            if [[ -n "$CHANGELOG_ENTRY" ]]; then
                echo "$CHANGELOG_ENTRY"
            fi
            exit 1
        fi

        echo -e "${BLUE}Generated Changelog:${NC}"
        echo "$CHANGELOG_ENTRY"
        echo "--------------------------------"
        if [[ "$NON_INTERACTIVE" == "true" ]]; then
            echo -e "${YELLOW}Accepting generated changelog in non-interactive mode.${NC}"
        else
            read -r -p "Press Enter to accept and continue, or Ctrl+C to abort..."
        fi
    fi

    if [ -f CHANGELOG.md ]; then
        {
            echo "$CHANGELOG_ENTRY"
            echo ""
            cat CHANGELOG.md
        } > CHANGELOG.tmp
        mv CHANGELOG.tmp CHANGELOG.md
    else
        {
            echo "# Changelog"
            echo ""
            echo "$CHANGELOG_ENTRY"
        } > CHANGELOG.md
    fi
fi

# ---------------------------------------------------------------------------
# Version bump (idempotent)
# ---------------------------------------------------------------------------

if [[ "$(get_package_version)" == "$NEW_VERSION" ]]; then
    echo -e "${YELLOW}package.json already at $NEW_VERSION${NC}"
else
    echo -e "${BLUE}Setting version to $NEW_VERSION...${NC}"
    # CHANGELOG.md may be uncommitted; disable pnpm's clean-working-tree check.
    pnpm version "$NEW_VERSION" --no-git-tag-version --allow-same-version --no-git-checks
fi

# ---------------------------------------------------------------------------
# Commit
# ---------------------------------------------------------------------------

COMMIT_DONE=false
if release_commit_exists "$NEW_VERSION"; then
    if file_is_dirty package.json || file_is_dirty CHANGELOG.md; then
        echo -e "${RED}Error: release commit for v$NEW_VERSION exists but package.json/CHANGELOG.md are still dirty.${NC}"
        echo -e "${RED}Resolve the dirty files manually, then re-run.${NC}"
        git status -s
        exit 1
    fi
    echo -e "${YELLOW}Skipping commit (release commit already exists)${NC}"
    COMMIT_DONE=true
else
    if [[ "$VALIDATED" != "true" ]]; then
        run_health_checks
        VALIDATED=true
    else
        echo -e "${BLUE}Building for v$NEW_VERSION...${NC}"
        pnpm run build
    fi

    echo -e "${BLUE}Committing changes...${NC}"
    git add package.json CHANGELOG.md
    # Nothing to commit means version/changelog already match HEAD without a release commit message.
    if git diff --cached --quiet; then
        echo -e "${RED}Error: no staged release changes, and no existing 'chore(release): v$NEW_VERSION' commit.${NC}"
        exit 1
    fi
    git commit -m "chore(release): v$NEW_VERSION"
    COMMIT_DONE=true
fi

# ---------------------------------------------------------------------------
# Tag
# ---------------------------------------------------------------------------

TAG_DONE=false
if tag_exists "$NEW_VERSION"; then
    echo -e "${YELLOW}Skipping tag creation (v$NEW_VERSION already exists)${NC}"
    TAG_DONE=true
else
    echo -e "${BLUE}Tagging version v$NEW_VERSION...${NC}"
    git tag "v$NEW_VERSION"
    TAG_DONE=true
fi

# ---------------------------------------------------------------------------
# Push (before publish — git is easier to recover than npm)
# ---------------------------------------------------------------------------

WANT_PUSH=false
PUSH_OK=false

if is_tag_on_remote "$NEW_VERSION"; then
    echo -e "${YELLOW}Skipping push (v$NEW_VERSION already on remote)${NC}"
    PUSH_OK=true
else
    case "$PUSH_MODE" in
        push)
            WANT_PUSH=true
            ;;
        skip)
            echo -e "${YELLOW}Skipping push (--no-push).${NC}"
            ;;
        prompt)
            read -r -p "Do you want to push commits and tags to remote? (y/N) " -n 1 -r
            echo
            if [[ $REPLY =~ ^[Yy]$ ]]; then
                WANT_PUSH=true
            else
                echo -e "${YELLOW}Skipping push.${NC}"
            fi
            ;;
    esac

    if [[ "$WANT_PUSH" == "true" ]]; then
        echo -e "${BLUE}Pushing release commit and v$NEW_VERSION tag...${NC}"
        if push_release_refs "$NEW_VERSION"; then
            if is_tag_on_remote "$NEW_VERSION"; then
                PUSH_OK=true
            else
                # Push exited 0 but the remote tag is not visible yet.
                echo -e "${YELLOW}Push succeeded but remote tag v$NEW_VERSION is not visible yet.${NC}"
                PUSH_OK=true
            fi
        else
            echo -e "${RED}Push failed after retries.${NC}"
            PUSH_OK=false
        fi
    fi
fi

# ---------------------------------------------------------------------------
# Publish
# ---------------------------------------------------------------------------

WANT_PUBLISH=false
PUBLISH_OK=false

PUBLISH_DELEGATED=false
if [[ "$PUBLISH_MODE" == "ci" ]]; then
    PUBLISH_DELEGATED=true
    if [[ "$PUSH_OK" == "true" ]]; then
        echo -e "${BLUE}npm publish delegated to GitHub Actions Trusted Publishing.${NC}"
    else
        echo -e "${YELLOW}npm publish is pending the release tag being pushed to GitHub.${NC}"
    fi
else
    WANT_PUBLISH=true

    ensure_npm_auth() {
        if pnpm whoami &>/dev/null; then
            return 0
        fi
        if [[ "$NON_INTERACTIVE" == "true" ]]; then
            echo -e "${RED}--publish-local requires an existing npm login in non-interactive mode.${NC}"
            return 1
        fi
        echo -e "${YELLOW}Not logged in to npm. Please log in:${NC}"
        pnpm login
        pnpm whoami &>/dev/null
    }

    do_publish() {
        ensure_npm_auth
        pnpm publish --access public --no-git-checks
    }

    echo -e "${BLUE}Publishing to npm locally (--publish-local)...${NC}"
    if retry 3 2 -- do_publish; then
        if is_published_on_npm "$NEW_VERSION"; then
            PUBLISH_OK=true
        else
            echo -e "${YELLOW}Publish command succeeded but registry does not list v$NEW_VERSION yet; probing once more...${NC}"
            sleep 2
            if is_published_on_npm "$NEW_VERSION"; then
                PUBLISH_OK=true
            else
                echo -e "${RED}Could not confirm v$NEW_VERSION on npm.${NC}"
                PUBLISH_OK=false
            fi
        fi
    else
        # Lost response: publish may have succeeded
        if is_published_on_npm "$NEW_VERSION"; then
            echo -e "${GREEN}Publish reported failure but v$NEW_VERSION is on npm — treating as success.${NC}"
            PUBLISH_OK=true
        else
            echo -e "${RED}npm publish failed after retries.${NC}"
            PUBLISH_OK=false
        fi
    fi
fi

# ---------------------------------------------------------------------------
# Summary / exit code
# ---------------------------------------------------------------------------

echo ""
echo -e "${BLUE}Release v$NEW_VERSION summary${NC}"
echo -e "  commit:  $([[ "$COMMIT_DONE" == "true" ]] && echo "yes" || echo "NO")"
echo -e "  tag:     $([[ "$TAG_DONE" == "true" ]] && echo "yes" || echo "NO")"
if [[ "$WANT_PUSH" == "true" ]]; then
    echo -e "  push:    $([[ "$PUSH_OK" == "true" ]] && echo "yes" || echo "FAILED")"
elif [[ "$PUSH_OK" == "true" ]]; then
    echo -e "  push:    already on remote"
else
    echo -e "  push:    skipped"
fi
if [[ "$PUBLISH_DELEGATED" == "true" ]]; then
    if [[ "$PUSH_OK" == "true" ]]; then
        echo -e "  npm:     delegated to GitHub Actions (OIDC)"
    else
        echo -e "  npm:     pending tag push"
    fi
elif [[ "$WANT_PUBLISH" == "true" ]]; then
    echo -e "  npm:     $([[ "$PUBLISH_OK" == "true" ]] && echo "yes" || echo "FAILED")"
else
    echo -e "  npm:     skipped"
fi

EXIT_CODE=0
if [[ "$COMMIT_DONE" != "true" || "$TAG_DONE" != "true" ]]; then
    EXIT_CODE=1
fi
if [[ "$WANT_PUSH" == "true" && "$PUSH_OK" != "true" ]]; then
    EXIT_CODE=1
fi
if [[ "$PUBLISH_MODE" == "local" && "$WANT_PUBLISH" == "true" && "$PUBLISH_OK" != "true" ]]; then
    EXIT_CODE=1
fi

if [[ "$EXIT_CODE" -eq 0 ]]; then
    echo -e "${GREEN}Release v$NEW_VERSION completed.${NC}"
    if [[ "$PUSH_OK" != "true" ]]; then
        echo -e "${YELLOW}To push and/or publish later: $0 $NEW_VERSION${NC}"
    fi
else
    echo -e "${RED}Release v$NEW_VERSION incomplete. Re-run: $0 $NEW_VERSION${NC}"
fi

exit "$EXIT_CODE"
