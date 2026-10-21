# Patched Seerr image for Unraid

The official Seerr image, built from the latest release plus the commits on
the `feat/plex-watchlist` branch (managing the Plex watchlist from the
watchlist button).

Image: `ghcr.io/gwlsn/seerr:latest`. It is a drop-in replacement for
`ghcr.io/seerr-team/seerr:latest`: it is built with upstream's own Dockerfile,
so `/app/config`, the user it runs as and port 5055 are all the same.

## How it stays up to date

`.github/workflows/build.yml` runs daily. It finds the latest upstream
release (pre-releases are skipped, as with the official `:latest`), checks out
that tag, cherry-picks the patch commits and builds. A build only happens when
the release, the patch branch or this branch changed.

## When the build fails

Usually the patch no longer applies to a new release. Rebase
`feat/plex-watchlist` onto upstream `develop`, fix the conflicts, push it,
then run the workflow from the Actions tab. Until then the server keeps
running the last image that built.

## Going back to stock

Set the container's repository back to `ghcr.io/seerr-team/seerr:latest`.
The patch makes no database changes.
