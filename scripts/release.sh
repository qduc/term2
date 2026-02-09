#!/bin/bash
set -e

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# Parse arguments
RESUME_MODE=false
RESUME_VERSION=""

print_usage() {
    echo "Usage: $0 [--resume [VERSION]]"
    echo ""
    echo "Options:"
    echo "  --resume [VERSION]  Resume a failed release. If VERSION is not provided,"
    echo "                      attempts to detect the version from package.json."
    echo ""
    echo "Examples:"
    echo "  $0                  # Start a new release"
    echo "  $0 --resume         # Resume release using version from package.json"
    echo "  $0 --resume 1.2.3   # Resume release for version 1.2.3"
}

while [[ $# -gt 0 ]]; do
    case $1 in
        --resume)
            RESUME_MODE=true
            if [[ -n "$2" && ! "$2" =~ ^-- ]]; then
                RESUME_VERSION="$2"
                shift
            fi
            shift
            ;;
        --help|-h)
            print_usage
            exit 0
            ;;
        *)
            echo -e "${RED}Unknown option: $1${NC}"
            print_usage
            exit 1
            ;;
    esac
done

echo -e "${BLUE}=== Release Script ===${NC}"

# Helper function to check if a tag exists
tag_exists() {
    git rev-parse "v$1" >/dev/null 2>&1
}

# Helper function to check if changelog has version entry
changelog_has_version() {
    if [ -f CHANGELOG.md ]; then
        grep -q "## \[$1\]" CHANGELOG.md 2>/dev/null
    else
        return 1
    fi
}

# Helper function to check if release commit exists
release_commit_exists() {
    git log --oneline -1 --grep="chore(release): v$1" 2>/dev/null | grep -q .
}

# Helper function to check if version is published on npm
is_published_on_npm() {
    local pkg_name
    pkg_name=$(node -p "require('./package.json').name")
    npm view "${pkg_name}@$1" version >/dev/null 2>&1
}

# 1. Check for uncommitted changes (skip in resume mode with appropriate conditions)
if [[ "$RESUME_MODE" == "true" ]]; then
    echo -e "${YELLOW}Resume mode: Skipping clean working directory check${NC}"
else
    if [[ -n $(git status -s) ]]; then
        echo -e "${RED}Error: Working directory is not clean. Please commit or stash changes.${NC}"
        git status -s
        exit 1
    fi
fi

# 2. Get current version from package.json
CURRENT_VERSION=$(node -p "require('./package.json').version")
echo -e "Current version in package.json: ${YELLOW}$CURRENT_VERSION${NC}"

# Determine the target version
if [[ "$RESUME_MODE" == "true" ]]; then
    if [[ -n "$RESUME_VERSION" ]]; then
        NEW_VERSION="$RESUME_VERSION"
    else
        # Use current version from package.json as the target
        NEW_VERSION="$CURRENT_VERSION"
    fi
    echo -e "${YELLOW}Resuming release for version: ${GREEN}$NEW_VERSION${NC}"

    # Detect current state
    echo -e "${BLUE}Detecting release state...${NC}"

    if tag_exists "$NEW_VERSION"; then
        echo -e "  ✓ Tag v$NEW_VERSION exists"
        TAG_DONE=true
    else
        echo -e "  ○ Tag v$NEW_VERSION does not exist"
        TAG_DONE=false
    fi

    if release_commit_exists "$NEW_VERSION"; then
        echo -e "  ✓ Release commit exists"
        COMMIT_DONE=true
    else
        echo -e "  ○ Release commit does not exist"
        COMMIT_DONE=false
    fi

    if changelog_has_version "$NEW_VERSION"; then
        echo -e "  ✓ Changelog has v$NEW_VERSION entry"
        CHANGELOG_DONE=true
    else
        echo -e "  ○ Changelog does not have v$NEW_VERSION entry"
        CHANGELOG_DONE=false
    fi

    if is_published_on_npm "$NEW_VERSION"; then
        echo -e "  ✓ Version $NEW_VERSION is published on npm"
        NPM_DONE=true
    else
        echo -e "  ○ Version $NEW_VERSION is not published on npm"
        NPM_DONE=false
    fi

    echo ""
else
    # Normal mode: clean state
    TAG_DONE=false
    COMMIT_DONE=false
    CHANGELOG_DONE=false
    NPM_DONE=false

    # 2.5 Run tests and build to ensure health
    echo -e "${BLUE}Running tests and building to ensure health...${NC}"
    npm test
    npm run build

    # 3. Select bump type
    echo "Select release type:"
    options=("Patch" "Minor" "Major" "Custom")
    select opt in "${options[@]}"
    do
        case $opt in
            "Patch")
                ver_output=$(npm version patch --no-git-tag-version --no-commit-hooks)
                NEW_VERSION=${ver_output#v}
                break
                ;;
            "Minor")
                ver_output=$(npm version minor --no-git-tag-version --no-commit-hooks)
                NEW_VERSION=${ver_output#v}
                break
                ;;
            "Major")
                ver_output=$(npm version major --no-git-tag-version --no-commit-hooks)
                NEW_VERSION=${ver_output#v}
                break
                ;;
            "Custom")
                read -p "Enter version: " NEW_VERSION
                # validate version format if possible, or trust npm version to fail later if invalid
                npm version $NEW_VERSION --no-git-tag-version --no-commit-hooks > /dev/null
                break
                ;;
            *) echo "Invalid option";;
        esac
    done

    # Revert the npm version change for now, we will apply it properly later with changelog
    git checkout package.json package-lock.json
fi

echo -e "Preparing release for version: ${GREEN}$NEW_VERSION${NC}"

# 4. Generate Changelog (skip if already done)
if [[ "$CHANGELOG_DONE" == "true" ]]; then
    echo -e "${YELLOW}Skipping changelog generation (already has v$NEW_VERSION entry)${NC}"
else
    echo -e "${BLUE}Generating changelog with Claude...${NC}"

    LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")

    if [ -z "$LAST_TAG" ]; then
        echo "No previous tags found. Using all commits."
        COMMITS=$(git log --pretty=format:"- %s (%h) by %an")
    else
        echo "Using commits since $LAST_TAG"
        COMMITS=$(git log ${LAST_TAG}..HEAD --pretty=format:"- %s (%h) by %an")
    fi

    if [ -z "$COMMITS" ]; then
        echo -e "${YELLOW}No commits found. Skipping changelog generation.${NC}"
        CHANGELOG_ENTRY=""
    else
        PROMPT="Generate a concise CHANGELOG.md entry for version $NEW_VERSION.
        Group changes into sections: Features, Bug Fixes, Improvements, and Internal/Chores.
        Here are the commits:
        $COMMITS

        Format as Markdown. Do not include a main title like 'Changelog', just the version header and sections.
        CRITICAL: Output ONLY the raw markdown content. Do NOT wrap in markdown code blocks (e.g., no \`\`\`markdown). Do not include any introductory or concluding remarks.
        Example format:
        ## [1.2.3] - 2023-01-01
        ### Features
        - ...
        "

        # Call Claude and filter out markdown code blocks or stray comments
        CHANGELOG_ENTRY=$(echo "$PROMPT" | claude --model haiku | sed -E '/^ *```/d' | sed -E 's/<\!--.*-->//g')

        echo -e "${BLUE}Generated Changelog:${NC}"
        echo "$CHANGELOG_ENTRY"
        echo "--------------------------------"
        read -p "Press Enter to accept and continue, or Ctrl+C to abort..."
    fi

    # 5. Apply changes - Generate new CHANGELOG.md
    if [ -f CHANGELOG.md ]; then
        echo "$CHANGELOG_ENTRY" > CHANGELOG.tmp
        echo "" >> CHANGELOG.tmp
        cat CHANGELOG.md >> CHANGELOG.tmp
        mv CHANGELOG.tmp CHANGELOG.md
    else
        echo "# Changelog" > CHANGELOG.md
        echo "" >> CHANGELOG.md
        echo "$CHANGELOG_ENTRY" >> CHANGELOG.md
    fi
fi

# Bump version (uses --allow-same-version for idempotency)
echo -e "${BLUE}Setting version to $NEW_VERSION...${NC}"
npm version $NEW_VERSION --no-git-tag-version --allow-same-version

# Skip verification if commit already exists (tests passed before)
if [[ "$COMMIT_DONE" == "true" ]]; then
    echo -e "${YELLOW}Skipping verification (release commit already exists)${NC}"
else
    # Final verification before commit
    echo -e "${BLUE}Running final verification tests for v$NEW_VERSION...${NC}"
    npm test
    npm run build

    # Commit
    echo -e "${BLUE}Committing changes...${NC}"
    git add package.json package-lock.json CHANGELOG.md
    git commit -m "chore(release): v$NEW_VERSION"
fi

# Tag (skip if already exists)
if [[ "$TAG_DONE" == "true" ]]; then
    echo -e "${YELLOW}Skipping tag creation (v$NEW_VERSION already exists)${NC}"
else
    echo -e "${BLUE}Tagging version v$NEW_VERSION...${NC}"
    git tag "v$NEW_VERSION"
fi

# 6. Publish
if [[ "$NPM_DONE" == "true" ]]; then
    echo -e "${YELLOW}Skipping npm publish (v$NEW_VERSION already published)${NC}"
else
    read -p "Do you want to publish to npm now? (y/N) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        # Check if npm session is valid
        echo -e "${BLUE}Checking npm authentication...${NC}"
        if ! npm whoami &>/dev/null; then
            echo -e "${YELLOW}Not logged in to npm. Please log in:${NC}"
            npm login
            if ! npm whoami &>/dev/null; then
                echo -e "${RED}npm login failed. Skipping publish.${NC}"
            else
                echo -e "${BLUE}Publishing to npm...${NC}"
                npm publish
            fi
        else
            NPM_USER=$(npm whoami)
            echo -e "${GREEN}Logged in as: $NPM_USER${NC}"
            echo -e "${BLUE}Publishing to npm...${NC}"
            npm publish
        fi
    fi
fi

# 7. Push
read -p "Do you want to push commits and tags to remote? (y/N) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo -e "${BLUE}Pushing to remote...${NC}"
    git push && git push --tags
fi

echo -e "${GREEN}Release v$NEW_VERSION completed!${NC}"
