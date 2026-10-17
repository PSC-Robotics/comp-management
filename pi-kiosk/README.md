# Raspberry Pi display kiosk

An SD card image that turns a Raspberry Pi 1 B+ into a screen that shows one Competition Control display full
screen. Nothing else runs on it: no desktop, X server or compositor. The browser is
[Cog](https://github.com/Igalia/cog) (WPE WebKit) drawing straight to the screen through
DRM/KMS. Chromium no longer runs on the Pi 1's ARMv6 processor.

## Build the image

Needs Docker (Docker Desktop on a Mac is fine) and about 4 GB of free disk space.

```sh
./build.sh
```

This downloads the latest Raspberry Pi OS Lite (32-bit), installs Cog and the kiosk service in an
emulated ARM chroot, removes things a screen does not need, and writes
`out/comp-kiosk-<date>.img.xz`. The download is cached in `out/cache/`; delete it to pick up a newer
Raspberry Pi OS. `KIOSK_HOSTNAME=foyer-tv ./build.sh` changes the default hostname (`comp-kiosk`).

## Flash and set up

1. Write the image with Raspberry Pi Imager (**Use custom**). Imager's OS customisation still
   works: set a hostname, a user and SSH if you want to log in remotely. A kiosk does not need any.
   The Pi 1 B+ has no Wi-Fi, so use Ethernet (or set Wi-Fi in Imager for a USB dongle).
2. Open the card's **bootfs** drive on any computer and edit `kiosk.txt`:
   - `SERVER` — the Competition Control address.
   - `DISPLAY` — the display's slug (the end of `/display/<slug>`). Leave it blank to choose on
     screen.
   - `RESOLUTION`, `ROTATION` (0/90/180/270 clockwise) and `ZOOM`.
3. Put the card in the Pi and power it on. The first boot takes a few minutes while Raspberry Pi OS
   grows the filesystem and applies Imager's settings.

While the server is unreachable the screen shows the address it is waiting for and the Pi's IP
address.

## Choosing a display on screen

With `DISPLAY` blank the Pi opens `/kiosk` on the server: a list of every enabled display of a
published, live or complete competition. Plug in a USB keyboard, use the arrow keys (or Tab) and
press Enter. The choice is remembered on the card. On each later boot the list appears with
"Opening … in 10 s"; press any key during those 10 seconds to choose again, or leave it. There is no
mouse pointer, so use the keyboard (a touchscreen also works).

Changing a display's settings in the admin portal still updates the screen live, as for any
other screen.

## What runs on the Pi

| File | Purpose |
| --- | --- |
| `/boot/firmware/kiosk.txt` | Settings above. |
| `/usr/local/bin/kiosk-launch` | Reads the settings, waits for the server, starts Cog. Restarts Cog if the server was unreachable for a minute or more and then came back, so a failed page load does not stick on an error page. |
| `/etc/systemd/system/kiosk.service` | Runs the launcher as the unprivileged `kiosk` user on tty1, restarting it if it exits. |

The image also adds `quiet … vc4.force_hotplug=1` to `cmdline.txt` (so HDMI works when the TV is
switched on after the Pi), sets `gpu_mem=16` for the Pi 1 (KMS does not use firmware GPU memory),
masks the tty1 login (a console login is still on Ctrl+Alt+F2), and disables the apt and man-db
timers. With a login set in Imager, `sudo journalctl -u kiosk` shows the launcher's log and
`sudo systemctl restart kiosk` reloads the screen.

## Limits on a Pi 1

The Pi 1 is slow, so expect pages to take a while to appear. Keep `RESOLUTION=1280x720`; at 1080p it
draws 2.25 times as many pixels. Board displays (schedule, league table, timer, arena, corner,
bracket) are the best fit. Custom screens with several panels and the SR screens (Polymer with
polyfills) work but are heavy. Live audio needs Chrome or Edge, so audio screens cannot play on the
Pi.
