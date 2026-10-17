#!/bin/sh
# Builds out/comp-kiosk-<date>.img.xz: Raspberry Pi OS Lite (32-bit) with the Cog kiosk preinstalled.
# Needs Docker (Docker Desktop on a Mac works). Usage: ./build.sh
set -eu
here=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$here/out"

# The image is customised in an ARM chroot, so Docker must be able to run 32-bit ARM binaries.
# Docker Desktop can out of the box; on a plain Linux host this installs the qemu handler.
if ! docker run --rm --platform linux/arm/v6 busybox:1.36 true >/dev/null 2>&1; then
  docker run --rm --privileged tonistiigi/binfmt:latest --install arm
fi

docker run --rm --privileged \
  -e BASE_URL="${BASE_URL:-https://downloads.raspberrypi.com/raspios_lite_armhf_latest}" \
  -e KIOSK_HOSTNAME="${KIOSK_HOSTNAME:-comp-kiosk}" \
  -v "$here:/work" debian:trixie-slim /work/build-image.sh
