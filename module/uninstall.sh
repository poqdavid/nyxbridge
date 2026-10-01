#!/system/bin/sh
# Stop the watcher, remove the address and rules it added, delete its data.
MODDIR=${0%/*}
"$MODDIR/bin/nyxbridge" cleanup || rm -rf /dev/nyxbridge /data/adb/nyxbridge
