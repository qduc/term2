#!/bin/bash
set -e

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${BLUE}=== Release Script ===${NC}"

# 1. Check for uncommitted changes
if [[ -n $(git status -s) ]]; then
  echo -e "${RED}Error: Working directory is not clean. Please commit or stash changes.${NC}"
  git status -s
  exit 1
fi

# 2. Get current version
CURRENT_VERSION=$(node -p "require('./package.json').version")
echo -e "Current version: ${YELLOW}$CURRENT_VERSION${NC}"

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

echo -e "Preparing release for version: ${GREEN}$NEW_VERSION${NC}"

# 4. Generate Changelog
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
    CHANGELOG_CONTENT=""
else
    PROMPT="Generate a concise CHANGELOG.md entry for version $NEW_VERSION.
    Group changes into sections: Features, Bug Fixes, Improvements, and Internal/Chores.
    Here are the commits:
    $COMMITS

    Format as Markdown. Do not include a main title like 'Changelog', just the version header and sections.
    Example format:
    ## [1.2.3] - 2023-01-01
    ### Features
    - ...
    "

    # Call Claude
    CHANGELOG_ENTRY=$(echo "$PROMPT" | claude --model haiku)

    echo -e "${BLUE}Generated Changelog:${NC}"
    echo "$CHANGELOG_ENTRY"
    echo "--------------------------------"
    read -p "Press Enter to accept and continue, or Ctrl+C to abort..."
fi

# 5. Apply changes
# Generate new CHANGELOG.md
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

# Bump version again (permanently this time)
npm version $NEW_VERSION --no-git-tag-version --allow-same-version

# Final verification before commit
echo -e "${BLUE}Running final verification tests for v$NEW_VERSION...${NC}"
npm test
npm run build

# Commit
echo -e "${BLUE}Committing changes...${NC}"
git add package.json package-lock.json CHANGELOG.md
git commit -m "chore(release): v$NEW_VERSION"

# Tag
echo -e "${BLUE}Tagging version v$NEW_VERSION...${NC}"
git tag "v$NEW_VERSION"

# 6. Publish
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

# 7. Push
read -p "Do you want to push commits and tags to remote? (y/N) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo -e "${BLUE}Pushing to remote...${NC}"
    git push && git push --tags
fi

echo -e "${GREEN}Release v$NEW_VERSION completed!${NC}"
