#!/usr/bin/env bash
# Publishes the viewer build to the gh-pages branch, or removes a published preview.
#
#   publish-pages.sh deploy <build-dir> <target>
#   publish-pages.sh remove <target>
#
# <target> is "root" for the main site or "pr-<number>" for a pull request preview.
# Deploying to root replaces the site but keeps the pr-* folders.
#
# Environment: GH_TOKEN and GITHUB_REPOSITORY (set in GitHub Actions); COMMIT_SHA
# (falls back to GITHUB_SHA) names the source commit in the gh-pages history.
# PAGES_REMOTE overrides the remote URL, e.g. a local bare repository for testing.
set -euo pipefail

usage() {
  echo "usage: $0 deploy <build-dir> <target> | remove <target>" >&2
  exit 2
}

mode="${1:-}"
case "$mode" in
  deploy)
    [ $# -eq 3 ] || usage
    build_dir="$(cd "$2" && pwd)"
    target="$3"
    if [ ! -f "$build_dir/index.html" ]; then
      echo "No index.html in $build_dir" >&2
      exit 1
    fi
    ;;
  remove)
    [ $# -eq 2 ] || usage
    target="$2"
    ;;
  *) usage ;;
esac

if [[ "$target" != root && ! "$target" =~ ^pr-[0-9]+$ ]]; then
  echo "Invalid target: $target (expected root or pr-<number>)" >&2
  exit 2
fi

branch=gh-pages
remote="${PAGES_REMOTE:-https://x-access-token:${GH_TOKEN:?GH_TOKEN is required}@github.com/${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}.git}"
commit="${COMMIT_SHA:-${GITHUB_SHA:-local}}"
workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

# One attempt: apply the change on top of the current branch tip and push it.
# Sets published=1 on success or when there is nothing to change; leaves
# published=0 if the push was rejected because the branch moved meanwhile.
# Any other error aborts the script (set -e applies: called as a plain command).
publish_once() {
  published=0
  cd "$workdir"
  rm -rf site
  git init -q -b "$branch" site
  cd site
  git config user.name 'github-actions[bot]'
  git config user.email '41898282+github-actions[bot]@users.noreply.github.com'
  git remote add origin "$remote"

  local status=0
  git ls-remote --exit-code --heads origin "$branch" > /dev/null || status=$?
  case "$status" in
    0)
      git fetch -q --depth=1 origin "$branch"
      git reset -q --hard FETCH_HEAD
      ;;
    2)
      if [ "$mode" = remove ]; then
        echo "No $branch branch yet; nothing to remove."
        published=1
        return
      fi
      ;;
    *)
      echo "Cannot read $branch from the remote." >&2
      exit 1
      ;;
  esac

  touch .nojekyll
  if [ "$mode" = remove ]; then
    rm -rf "$target"
  elif [ "$target" = root ]; then
    find . -mindepth 1 -maxdepth 1 ! -name .git ! -name .nojekyll ! -name 'pr-*' -exec rm -rf {} +
    cp -R "$build_dir/." .
  else
    rm -rf "$target"
    mkdir "$target"
    cp -R "$build_dir/." "$target/"
  fi

  # The branch holds generated files only, so staging everything is intended here.
  git add --all
  if git diff --cached --quiet; then
    echo "Nothing to change on $branch."
    published=1
    return
  fi
  local message="Deploy $target from $commit"
  if [ "$mode" = remove ]; then
    message="Remove $target"
  fi
  git commit -q -m "$message"
  # No force push: if the branch moved, the push is rejected and the attempt is retried.
  if git push -q origin "HEAD:refs/heads/$branch"; then
    echo "$message: pushed to $branch."
    published=1
  fi
}

for attempt in 1 2 3 4 5; do
  publish_once
  if [ "$published" = 1 ]; then
    exit 0
  fi
  echo "Push rejected (attempt $attempt of 5); retrying on the new $branch tip." >&2
  sleep $((attempt * 2))
done
echo "Could not publish $target to $branch." >&2
exit 1
