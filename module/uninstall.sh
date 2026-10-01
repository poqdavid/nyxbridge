#!/system/bin/sh
# Stop the watcher, remove the address and rules it added, delete its data.
MODDIR=${0%/*}
. "$MODDIR/utils.sh"

stop_daemon
if [ -d "$RUN_DIR" ] || [ -d "$DATA_DIR" ]; then
    load_config
    load_applied
    remove_all
fi
rm -rf "$RUN_DIR" "$DATA_DIR"
