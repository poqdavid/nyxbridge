#!/system/bin/sh
# NyxBridge - background watcher, started by service.sh.
#
# Reacts to link/address events from `ip monitor` that mention the bridge,
# and re-checks everything every 30 seconds anyway (netd flushes all policy
# rules when it restarts, and the monitor itself can die).
#
# shellcheck disable=SC3043,SC3045  # 'local' and 'read -t' exist in mksh and busybox ash

MODDIR=${0%/*}
. "$MODDIR/utils.sh"

init_dirs || exit 1

pidfile_claim "$RUN_DIR/daemon.pid" || exit 0

if ! monitor_enabled; then
    log_msg "Monitoring is off; the watcher stays stopped"
    rm -f "$RUN_DIR/daemon.pid"
    exit 0
fi

FIFO="$RUN_DIR/events"
rm -f "$FIFO"
if ! mkfifo -m 600 "$FIFO"; then
    log_msg "Could not create $FIFO; stopping"
    rm -f "$RUN_DIR/daemon.pid"
    exit 1
fi

exec 3<> "$FIFO"

PARENT=$$
(
    exec 3<&-
    mpid='' spid=''
    trap 'kill "$spid" "$mpid" 2>/dev/null; exit 0' TERM INT HUP
    while kill -0 "$PARENT" 2> /dev/null; do
        "$IP_BIN" -o monitor link address < /dev/null &
        mpid=$!
        echo "$mpid $(proc_start "$mpid")" > "$RUN_DIR/monitor.pid"
        while kill -0 "$PARENT" 2> /dev/null && kill -0 "$mpid" 2> /dev/null; do
            sleep 5 &
            spid=$!
            wait "$spid"
        done
        kill "$mpid" 2> /dev/null
        sleep 1
    done
    rm -f "$RUN_DIR/monitor.pid"
) > "$FIFO" 2> /dev/null &
MON=$!

shutdown() {
    kill "$MON" 2> /dev/null
    kill_monitor
    rm -f "$RUN_DIR/daemon.pid" "$FIFO"
    log_msg "Watcher stopped"
}

IN_CHECK=0
STOP=0
on_signal() {
    if [ "$IN_CHECK" = 1 ]; then
        STOP=1
    else
        shutdown
        exit 0
    fi
}
trap on_signal TERM INT HUP

check_now() {
    IN_CHECK=1
    reconcile_locked
    IN_CHECK=0
    if [ "$STOP" = 1 ]; then
        shutdown
        exit 0
    fi
    WATCH=${VA_BRIDGE:-$DEFAULT_BRIDGE}
    last=$(date +%s)
}

log_msg "Watcher started (pid $$)"
check_now

while :; do
    want=0
    if read -t 30 -r line <&3; then
        case "$line" in
            *"$WATCH"*) want=1 ;;
        esac
        if [ "$want" = 1 ]; then
            n=0
            while [ "$n" -lt 50 ] && read -t 1 -r line <&3; do
                n=$((n + 1))
            done
        fi
    fi
    now=$(date +%s)
    [ $((now - last)) -ge 30 ] && want=1
    if [ "$want" = 1 ]; then
        if ! monitor_enabled; then
            log_msg "Monitoring is off in config.sh"
            shutdown
            exit 0
        fi
        check_now
    fi
done
