# Patched Seerr image for Unraid

[hotio's Seerr image](https://hotio.dev/containers/seerr) with the Seerr app
rebuilt from the latest release plus the commits on the `feat/plex-watchlist`
branch (managing the Plex watchlist from the watchlist button).

Image: `ghcr.io/gwlsn/seerr:release`. It is a drop-in replacement for
`ghcr.io/hotio/seerr:release`: same `/config`, PUID/PGID, UMASK and port.

## How it stays up to date

`.github/workflows/build.yml` runs daily. It reads which Seerr version
`hotio/seerr:release` holds, checks out that upstream tag, cherry-picks the
patch commits and builds on top of hotio's image. A build only happens when
the hotio image, the patch branch or this branch changed.

## When the build fails

Usually the patch no longer applies to a new release. Rebase
`feat/plex-watchlist` onto upstream `develop`, fix the conflicts, push it,
then run the workflow from the Actions tab. Until then the server keeps
running the last image that built.

## Going back to stock

Set the container's repository back to `ghcr.io/hotio/seerr:release`. The
patch makes no database changes.
