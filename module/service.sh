#!/system/bin/sh
# Start the watcher in the background; it waits for VirtualAP by itself.
MODDIR=${0%/*}
/system/bin/sh "$MODDIR/watcher.sh" < /dev/null > /dev/null 2>&1 &
