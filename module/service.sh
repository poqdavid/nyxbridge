#!/system/bin/sh
# Start the watcher. The logic lives in bin/nyxbridge (Rust); KernelSU runs
# this file by name, so it is a thin wrapper.
MODDIR=${0%/*}
# A failed exec ends the shell on the spot, so the binary is tried first:
# one that is missing or can't run here gets a log line instead.
if "$MODDIR/bin/nyxbridge" --version > /dev/null 2>&1; then
    exec "$MODDIR/bin/nyxbridge" boot
fi
mkdir -p /data/adb/nyxbridge
echo "$(date '+%Y-%m-%d %H:%M:%S') [error] bin/nyxbridge can't run on this device" >> /data/adb/nyxbridge/nyxbridge.log
exit 0
