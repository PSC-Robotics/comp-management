#!/bin/bash
# Runs inside the privileged build container (see build.sh).
set -euo pipefail
apt-get update -qq
apt-get install -y -qq --no-install-recommends ca-certificates curl xz-utils fdisk e2fsprogs dosfstools mount >/dev/null

cd /work/out
mkdir -p cache
base=cache/raspios-lite-armhf.img.xz
if [ ! -s "$base" ]; then
  echo "Downloading $BASE_URL"
  curl -fL --retry 3 -o "$base.part" "$BASE_URL"
  mv "$base.part" "$base"
fi

img=build.img
rm -f "$img"
xz -dc "$base" > "$img"
# Room for the browser; the Pi still grows the root partition to fill the card on first boot.
truncate -s +768M "$img"
echo ', +' | sfdisk -q --no-reread -N 2 "$img"

part() { sfdisk -d "$img" | sed -n "s/^.*$1 : start= *\([0-9]*\), size= *\([0-9]*\).*/\1 \2/p"; }
read -r boot_start boot_size < <(part "${img}1")
read -r root_start root_size < <(part "${img}2")
root_loop=$(losetup -f --show -o $((root_start * 512)) --sizelimit $((root_size * 512)) "$img")
boot_loop=$(losetup -f --show -o $((boot_start * 512)) --sizelimit $((boot_size * 512)) "$img")

root=/mnt/root
unmount() {
  for m in boot/firmware dev/pts dev sys proc; do umount "$root/$m" 2>/dev/null || true; done
  umount "$root" 2>/dev/null || true
}
trap 'unmount; losetup -d "$boot_loop" "$root_loop" 2>/dev/null' EXIT

e2fsck -fy "$root_loop" >/dev/null || [ $? -le 1 ]
resize2fs -p "$root_loop" >/dev/null
mkdir -p "$root"
mount "$root_loop" "$root"
mount "$boot_loop" "$root/boot/firmware"
for m in proc sys dev dev/pts; do mount --bind "/$m" "$root/$m"; done

cp -a "$root/etc/resolv.conf" /tmp/resolv.conf.orig 2>/dev/null || true
rm -f "$root/etc/resolv.conf"; cp /etc/resolv.conf "$root/etc/resolv.conf"
printf '#!/bin/sh\nexit 101\n' > "$root/usr/sbin/policy-rc.d"; chmod +x "$root/usr/sbin/policy-rc.d"

install -m 0755 /work/files/kiosk-launch "$root/usr/local/bin/kiosk-launch"
install -m 0644 /work/files/kiosk.service "$root/etc/systemd/system/kiosk.service"
install -m 0644 /work/files/kiosk.txt "$root/boot/firmware/kiosk.txt"

chroot "$root" /bin/bash -euo pipefail <<CHROOT
export DEBIAN_FRONTEND=noninteractive LC_ALL=C
apt-get update -qq
apt-get install -y -q --no-install-recommends cog libegl-mesa0 libgles2 libgl1-mesa-dri fonts-dejavu-core

# Nothing on a display screen needs these; dropping them saves space, RAM and boot time.
# Kernels for other Pi models go too, so the card boots a Pi 1 or Zero only. Realtek firmware
# stays for USB Wi-Fi and Ethernet adapters.
unwanted=\$(dpkg-query -Wf '\${Package}\n' | grep -E '^(man-db|manpages.*|triggerhappy|bluez.*|pi-bluetooth|modemmanager|rpi-connect-lite|avahi-daemon|cups-browsed|nfs-common|rpcbind|build-essential|gcc|gcc-14|cpp|cpp-14|g\+\+.*|libc6-dev|linux-headers-.*|linux-image-.*(v7|v7l|v8|2712)|firmware-(atheros|brcm80211|libertas|mediatek)|rpi-eeprom)\$' || true)
[ -n "\$unwanted" ] && apt-get purge -y -q --auto-remove \$unwanted
apt-get clean
rm -rf /var/lib/apt/lists/* /usr/share/doc/* /usr/share/man/* /var/cache/man/*

useradd --system --home-dir /var/lib/kiosk --create-home --shell /usr/sbin/nologin kiosk
systemctl enable kiosk.service
# tty1 belongs to the kiosk; a console login is still on Ctrl+Alt+F2.
systemctl mask getty@tty1.service
for t in apt-daily.timer apt-daily-upgrade.timer man-db.timer e2scrub_all.timer fstrim.timer; do
  systemctl disable "\$t" 2>/dev/null || true
done
# Raspberry Pi OS asks for a username on the console when the card was not customised in
# Raspberry Pi Imager. A kiosk needs no login, so only run that step when Imager supplied one.
if [ -f /usr/lib/systemd/system/userconfig.service ] || [ -f /lib/systemd/system/userconfig.service ]; then
  mkdir -p /etc/systemd/system/userconfig.service.d
  printf '[Unit]\nConditionPathExists=/boot/firmware/userconf.txt\n' > /etc/systemd/system/userconfig.service.d/kiosk.conf
fi
echo "$KIOSK_HOSTNAME" > /etc/hostname
sed -i "s/raspberrypi/$KIOSK_HOSTNAME/g" /etc/hosts
CHROOT

rm -f "$root/usr/sbin/policy-rc.d" "$root/etc/resolv.conf"
cp -a /tmp/resolv.conf.orig "$root/etc/resolv.conf" 2>/dev/null || true

# Quiet boot straight to the browser. vc4.force_hotplug keeps HDMI on when the TV is switched
# on after the Pi. A Pi 1 drives the screen through KMS, so the firmware needs almost no GPU memory.
sed -i '1s/$/ quiet loglevel=3 logo.nologo vt.global_cursor_default=0 consoleblank=0 vc4.force_hotplug=1/' "$root/boot/firmware/cmdline.txt"
printf '\n[all]\ndisable_splash=1\n\n[pi1]\ngpu_mem=16\n\n[all]\n' >> "$root/boot/firmware/config.txt"

fstrim "$root" 2>/dev/null || true
unmount
e2fsck -fy "$root_loop" >/dev/null || [ $? -le 1 ]
losetup -d "$boot_loop" "$root_loop"
trap - EXIT

out="comp-kiosk-$(date +%Y%m%d).img.xz"
echo "Compressing $out"
xz -T0 -6 -c "$img" > "$out"
rm -f "$img"
ls -lh "$out"
