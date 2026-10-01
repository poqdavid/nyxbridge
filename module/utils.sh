#!/system/bin/sh
# NyxBridge - shared logic, sourced by watcher.sh, ctl.sh and uninstall.sh.
#
# Gives the Android host an address on VirtualAP's managed-mode bridge
# (vap-br0) and adds the policy rules Android needs so the phone's own apps
# can reach hotspot devices. Everything here is idempotent: reconcile()
# compares the live state with what should exist and only changes the
# difference, so the daemon, the WebUI and the Action button can all call it.
#
# shellcheck disable=SC3043  # 'local' is supported by mksh and busybox ash

export PATH="/system/bin:/system/xbin:$PATH"

MODULE_ID=nyxbridge
DATA_DIR=${NYXB_DATA_DIR:-/data/adb/$MODULE_ID}
RUN_DIR=${NYXB_RUN_DIR:-/dev/$MODULE_ID}
VA_STATE=${NYXB_VA_STATE:-/data/local/virtualap/run.state}
IP_BIN=${NYXB_IP_BIN:-/system/bin/ip}
SH_BIN=${NYXB_SH_BIN:-/system/bin/sh}
SYS_NET=${NYXB_SYS_NET:-/sys/class/net}
PROC_V6=${NYXB_PROC_V6:-/proc/sys/net/ipv6/conf}

MODULE_PROP=${NYXB_MODULE_PROP:-$MODDIR/module.prop}
CONF=$DATA_DIR/config.sh
LOG=$DATA_DIR/nyxbridge.log
APPLIED=$RUN_DIR/applied
STATUS=$RUN_DIR/status
DEFAULT_BRIDGE=vap-br0

CR=$(printf '\r')

kv_set() {
    local _kv_line _kv_val=''
    if [ -f "$2" ]; then
        while IFS= read -r _kv_line || [ -n "$_kv_line" ]; do
            case "$_kv_line" in
                "$3="*)
                    _kv_val=${_kv_line#"$3="}
                    _kv_val=${_kv_val%"$CR"}
                    break
                    ;;
            esac
        done < "$2"
    fi
    eval "$1=\$_kv_val"
}

kv_get() {
    local _kv_out
    kv_set _kv_out "$1" "$2"
    printf '%s\n' "$_kv_out"
}

is_num() {
    case "$1" in
        '' | *[!0-9]* | 0?*) return 1 ;;
    esac
    [ "$1" -ge "$2" ] && [ "$1" -le "$3" ]
}

valid_ifname() {
    local rest="$1" ch
    case "$rest" in '' | . | ..) return 1 ;; esac
    [ "${#rest}" -le 15 ] || return 1
    while [ -n "$rest" ]; do
        ch=${rest%"${rest#?}"}
        case "$ch" in
            [A-Za-z0-9] | . | _ | -) ;;
            *) return 1 ;;
        esac
        rest=${rest#?}
    done
}

log_msg() {
    printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG" 2> /dev/null
    local size
    size=$(wc -c < "$LOG" 2> /dev/null)
    if [ "${size:-0}" -gt 65536 ]; then
        tail -n 300 "$LOG" > "$LOG.tmp" 2> /dev/null && mv -f "$LOG.tmp" "$LOG"
    fi
}

init_dirs() {
    mkdir -p "$DATA_DIR" "$RUN_DIR" || return 1
    # Root only: everything the module writes lives in these two folders.
    chmod 700 "$DATA_DIR" "$RUN_DIR" 2> /dev/null
    [ -f "$CONF" ] || write_default_config
}

module_flagged() {
    [ -n "$MODDIR" ] && { [ -e "$MODDIR/disable" ] || [ -e "$MODDIR/remove" ]; }
}

cfg_get() {
    local _cv
    kv_set _cv "$CONF" "$2"
    case "$_cv" in
        \'*\') _cv=${_cv#\'} _cv=${_cv%\'} ;;
    esac
    eval "$1=\$_cv"
}

load_config() {
    cfg_get CFG_ENABLED enabled
    case "$CFG_ENABLED" in 0 | 1) ;; *) CFG_ENABLED=1 ;; esac
    cfg_get CFG_IPV6 ipv6
    case "$CFG_IPV6" in 0 | 1) ;; *) CFG_IPV6=0 ;; esac
    cfg_get CFG_HOST host_octet
    is_num "$CFG_HOST" 1 254 || CFG_HOST=2
    cfg_get CFG_PREF rule_pref
    is_num "$CFG_PREF" 1 32765 || CFG_PREF=7001
}

write_default_config() {
    if [ -n "$MODDIR" ] && [ -f "$MODDIR/config.sh" ]; then
        cat "$MODDIR/config.sh" > "$CONF.$$"
    else
        printf '%s\n' 'enabled=1' 'monitor=1' 'ipv6=0' 'host_octet=2' 'rule_pref=7001' \
            'webui_theme=system' 'webui_monet=1' 'webui_fullscreen=1' > "$CONF.$$"
    fi
    chmod 600 "$CONF.$$" && mv -f "$CONF.$$" "$CONF"
}

config_set() {
    local line found=0 tmp="$CONF.$$"
    [ -f "$CONF" ] || write_default_config
    {
        while IFS= read -r line || [ -n "$line" ]; do
            case "$line" in
                "$1="*)
                    if [ "$found" = 0 ]; then echo "$1=$2"; fi
                    found=1
                    ;;
                *) printf '%s\n' "$line" ;;
            esac
        done < "$CONF"
        if [ "$found" = 0 ]; then echo "$1=$2"; fi
    } > "$tmp" && chmod 600 "$tmp" && mv -f "$tmp" "$CONF"
}

load_va() {
    VA_MODE=stopped
    VA_GW=
    VA_BRIDGE=$DEFAULT_BRIDGE
    [ -f "$VA_STATE" ] || return 0
    kv_set VA_MODE "$VA_STATE" mode
    [ -n "$VA_MODE" ] || VA_MODE=routed
    kv_set VA_GW "$VA_STATE" gateway
    local b
    kv_set b "$VA_STATE" bridge
    if valid_ifname "$b"; then VA_BRIDGE=$b; fi
}

parse_gw() {
    local rest="$1" a b c d
    a=${rest%%.*}
    rest=${rest#*.}
    b=${rest%%.*}
    rest=${rest#*.}
    c=${rest%%.*}
    d=${rest#*.}
    [ "$a.$b.$c.$d" = "$1" ] || return 1
    is_num "$a" 0 255 && is_num "$b" 0 255 && is_num "$c" 0 255 && is_num "$d" 1 254 || return 1
    echo "$a.$b.$c $d"
}

load_applied() {
    kv_set A4_ADDR "$APPLIED" A4_ADDR
    kv_set A4_BR "$APPLIED" A4_BR
    kv_set A4_IDX "$APPLIED" A4_IDX
    kv_set A6_BR "$APPLIED" A6_BR
    kv_set A6_IDX "$APPLIED" A6_IDX
    kv_set SIG6 "$APPLIED" SIG6
    APPLIED_WAS="$A4_ADDR|$A4_BR|$A4_IDX|$A6_BR|$A6_IDX|$SIG6"
}

save_applied() {
    [ -f "$APPLIED" ] \
        && [ "$A4_ADDR|$A4_BR|$A4_IDX|$A6_BR|$A6_IDX|$SIG6" = "$APPLIED_WAS" ] && return 0
    {
        echo "A4_ADDR=$A4_ADDR"
        echo "A4_BR=$A4_BR"
        echo "A4_IDX=$A4_IDX"
        echo "A6_BR=$A6_BR"
        echo "A6_IDX=$A6_IDX"
        echo "SIG6=$SIG6"
    } > "$APPLIED.tmp" && mv -f "$APPLIED.tmp" "$APPLIED"
}

if_index() {
    local v
    { read -r v < "$SYS_NET/$1/ifindex"; } 2> /dev/null && echo "$v"
}

same_instance() {
    [ -n "$1" ] && [ -n "$2" ] && [ "$(if_index "$1")" = "$2" ]
}

rules_at_pref() {
    "$IP_BIN" -"$1" rule show 2> /dev/null | while read -r prio spec; do
        [ "$prio" = "$CFG_PREF:" ] || continue
        set -f
        # shellcheck disable=SC2086
        set -- $spec
        set +f
        echo "$*"
    done
}

rule_count() {
    local n
    n=$(rules_at_pref "$1" | grep -c .)
    echo "${n:-0}"
}

rule_flush() {
    local i=0
    while [ "$i" -lt 64 ] && "$IP_BIN" -"$1" rule del pref "$CFG_PREF" 2> /dev/null; do
        i=$((i + 1))
    done
}

rule_line_present() {
    rules_at_pref "$1" | grep -Fxq -- "$2"
}

has_v6_global() {
    "$IP_BIN" -6 -o addr show dev "$1" scope global 2> /dev/null | grep -q inet6
}

v6_prepare() {
    local p="$PROC_V6/$1"
    echo 0 > "$p/disable_ipv6" 2> /dev/null
    echo 2 > "$p/accept_ra" 2> /dev/null
    echo 0 > "$p/accept_ra_defrtr" 2> /dev/null
    echo 1 > "$p/autoconf" 2> /dev/null
    if ! has_v6_global "$1"; then
        echo 1 > "$p/disable_ipv6" 2> /dev/null
        echo 0 > "$p/disable_ipv6" 2> /dev/null
    fi
}

v6_restore() {
    local p="$PROC_V6/$1" d="$PROC_V6/default" k
    for k in accept_ra accept_ra_defrtr autoconf; do
        [ -f "$d/$k" ] && cat "$d/$k" > "$p/$k" 2> /dev/null
    done
    "$IP_BIN" -6 addr flush dev "$1" scope global dynamic 2> /dev/null
}

v6_targets() {
    "$IP_BIN" -6 route show table all dev "$1" 2> /dev/null | awk -v br="$1" '
        {
            d = $1
            if (d == "local" || d == "multicast" || d == "anycast" ||
                d == "broadcast" || d == "unreachable" || d == "prohibit" ||
                d == "blackhole" || d == "throw" || d == "nat") next
            if (d == "default" || d == "::/0") next
            if (index(d, ":") == 0 || index(d, "/") == 0) next
            split(d, a, "/")
            if (a[2] + 0 >= 128) next
            t = "main"
            for (i = 2; i < NF; i++) if ($i == "table") t = $(i + 1)
            if (t == "local") next
            key = (tolower(d) ~ /^fe80:/) ? ("oif " br) : ("to " d)
            if (seen[key]++) next
            print key " lookup " t
        }' | sort
}

remove_all() {
    if [ "$(rule_count 4)" -gt 0 ]; then
        rule_flush 4
        log_msg "Removed IPv4 rule $CFG_PREF"
    fi
    if [ "$(rule_count 6)" -gt 0 ]; then
        rule_flush 6
        log_msg "Removed IPv6 rules $CFG_PREF"
    fi
    if [ -n "$A4_ADDR" ] && same_instance "$A4_BR" "$A4_IDX"; then
        "$IP_BIN" addr del "$A4_ADDR" dev "$A4_BR" 2> /dev/null \
            && log_msg "Removed $A4_ADDR from $A4_BR"
    fi
    if [ -n "$A6_IDX" ] && same_instance "$A6_BR" "$A6_IDX"; then
        v6_restore "$A6_BR"
        log_msg "IPv6 settings on $A6_BR restored"
    fi
    A4_ADDR='' A4_BR='' A4_IDX='' A6_BR='' A6_IDX='' SIG6=''
}

apply_v4() {
    local br="$1" base="$2" idx="$3"
    local want="$base.$CFG_HOST/24" subnet="$base.0/24"

    if [ -n "$A4_ADDR" ] && [ "$A4_ADDR" != "$want" ]; then
        "$IP_BIN" addr del "$A4_ADDR" dev "$br" 2> /dev/null \
            && log_msg "Removed old $A4_ADDR from $br"
        A4_ADDR=
    fi
    if ! "$IP_BIN" -4 -o addr show dev "$br" 2> /dev/null | grep -Fq " inet $want "; then
        if "$IP_BIN" addr add "$want" dev "$br" 2> /dev/null; then
            log_msg "Added $want to $br"
        else
            set_reason addr_failed "$want" "Could not add $want to $br"
            log_msg "$REASON"
            return 1
        fi
    fi
    A4_ADDR=$want A4_BR=$br A4_IDX=$idx

    if [ "$(rule_count 4)" != 1 ] || ! rule_line_present 4 "from all to $subnet lookup main"; then
        rule_flush 4
        if "$IP_BIN" -4 rule add pref "$CFG_PREF" to "$subnet" lookup main 2> /dev/null; then
            log_msg "Added rule $CFG_PREF: to $subnet lookup main"
        else
            set_reason rule_failed "" "Could not add the IPv4 routing rule"
            log_msg "$REASON"
            return 1
        fi
    fi
}

apply_v6() {
    local br="$1" idx="$2" targets sig want fails
    if [ ! -d "$PROC_V6/$br" ]; then
        set_reason ipv6_unavailable "$br" "IPv6 is not available on $br"
        return 1
    fi
    if [ -z "$A6_IDX" ]; then
        v6_prepare "$br"
        A6_BR=$br A6_IDX=$idx
        log_msg "IPv6 on: $br now accepts OpenWrt's router advertisements (no default route)"
    fi
    targets=$(v6_targets "$br")
    sig=$(printf '%s' "$targets" | tr '\n' ';')
    want=$(printf '%s\n' "$targets" | grep -c .)
    if [ "$(rule_count 6)" != "$want" ] || [ "$sig" != "$SIG6" ]; then
        rule_flush 6
        fails=$(printf '%s\n' "$targets" | while read -r kind what _lookup tbl; do
            [ -n "$kind" ] || continue
            "$IP_BIN" -6 rule add pref "$CFG_PREF" "$kind" "$what" lookup "$tbl" 2> /dev/null \
                || printf '%s ' "$kind $what"
        done)
        if [ "$sig" != "$SIG6" ]; then
            if [ -n "$targets" ]; then
                log_msg "IPv6 rules: $(printf '%s' "$targets" | tr '\n' ',' | sed 's/,/, /g')"
            else
                log_msg "IPv6: waiting for OpenWrt to announce a prefix on $br"
            fi
            [ -z "$fails" ] || log_msg "IPv6 rule failed: $fails"
        fi
        SIG6=$sig
    fi
    return 0
}

remove_v6_only() {
    if [ "$(rule_count 6)" -gt 0 ]; then
        rule_flush 6
        log_msg "Removed IPv6 rules $CFG_PREF"
    fi
    if [ -n "$A6_IDX" ]; then
        if same_instance "$A6_BR" "$A6_IDX"; then
            v6_restore "$A6_BR"
            log_msg "IPv6 off: settings on $A6_BR restored"
        fi
        A6_BR='' A6_IDX='' SIG6=''
    fi
}

set_reason() {
    REASON_CODE=$1 REASON_ARG=$2 REASON=$3
}

update_description() {
    local desc
    [ -f "$MODULE_PROP" ] || return 0
    case "$STATE" in
        active) desc="[✅ Active] ${A4_ADDR%/*} on $VA_BRIDGE — details in the WebUI" ;;
        error) desc="[⚠️ Problem] $REASON — details in the WebUI" ;;
        *) desc="[💤 Idle] $REASON — details in the WebUI" ;;
    esac
    NYX_DESC="$desc" awk '
        BEGIN { done = 0; d = ENVIRON["NYX_DESC"] }
        done == 0 && /^description=/ { print "description=" d; done = 1; next }
        { print }
        END { if (done == 0) print "description=" d }
    ' "$MODULE_PROP" > "$MODULE_PROP.nyxtmp" && mv -f "$MODULE_PROP.nyxtmp" "$MODULE_PROP"
}

write_status() {
    local old_state old_reason
    kv_set old_state "$STATUS" state
    kv_set old_reason "$STATUS" reason
    {
        echo "state=$STATE"
        echo "reason=$REASON"
        echo "reason_code=$REASON_CODE"
        echo "reason_arg=$REASON_ARG"
        echo "time=$(date '+%Y-%m-%d %H:%M:%S')"
    } > "$STATUS.tmp" && mv -f "$STATUS.tmp" "$STATUS"
    if [ "$STATE" != "$old_state" ] || [ "$REASON" != "$old_reason" ]; then
        if [ "$STATE" = active ]; then
            log_msg "Active on $VA_BRIDGE"
        else
            log_msg "${STATE}: $REASON"
        fi
        update_description
    fi
}

reconcile() {
    local br gwinfo base gwo idx
    load_config
    load_va
    load_applied
    STATE=inactive
    REASON='' REASON_CODE='' REASON_ARG=''
    br=$VA_BRIDGE

    if module_flagged; then
        set_reason module_disabled "" "Module is disabled in the root manager"
    elif [ "$CFG_ENABLED" != 1 ]; then
        set_reason turned_off "" "Turned off in settings"
    elif [ "$VA_MODE" = stopped ]; then
        set_reason va_stopped "" "VirtualAP is not running"
    elif [ "$VA_MODE" != bridged ]; then
        set_reason va_routed "" "VirtualAP is in routed mode (the phone is already the gateway there)"
    elif ! gwinfo=$(parse_gw "$VA_GW"); then
        set_reason bad_gateway "" "VirtualAP's gateway address is missing or invalid"
    elif [ ! -d "$SYS_NET/$br" ]; then
        set_reason waiting_bridge "$br" "Waiting for $br"
    else
        base=${gwinfo% *}
        gwo=${gwinfo#* }
        if [ "$CFG_HOST" = "$gwo" ]; then
            STATE=error
            set_reason host_is_gateway ".$CFG_HOST" "Phone address .$CFG_HOST is the gateway's address; pick another"
        else
            STATE=active
        fi
    fi

    if [ "$STATE" = active ]; then
        idx=$(if_index "$br")
        if [ "$A4_BR" != "$br" ] || [ "$A4_IDX" != "$idx" ]; then A4_ADDR=; fi
        if [ "$A6_BR" != "$br" ] || [ "$A6_IDX" != "$idx" ]; then
            A6_BR='' A6_IDX='' SIG6=''
        fi
        if ! apply_v4 "$br" "$base" "$idx"; then
            STATE=error
        elif [ "$CFG_IPV6" = 1 ]; then
            apply_v6 "$br" "$idx" || STATE=error
        else
            remove_v6_only
        fi
    else
        remove_all
    fi
    save_applied
    write_status
}

proc_start() {
    local stat
    { read -r stat < "/proc/$1/stat"; } 2> /dev/null || return 1
    stat=${stat##*) }
    set -f
    # shellcheck disable=SC2086
    set -- $stat
    set +f
    [ "$#" -ge 20 ] || return 1
    echo "${20}"
}

pidfile_alive() {
    local pid start now
    { read -r pid start < "$1"; } 2> /dev/null || return 1
    case "$pid" in '' | *[!0-9]*) return 1 ;; esac
    now=$(proc_start "$pid") || return 1
    [ "$now" = "$start" ] || return 1
    echo "$pid"
}

pidfile_claim() {
    local me
    me="$$ $(proc_start $$)"
    if (set -C && echo "$me" > "$1") 2> /dev/null; then return 0; fi
    pidfile_alive "$1" > /dev/null && return 1
    rm -f "$1"
    (set -C && echo "$me" > "$1") 2> /dev/null
}

lock_acquire() {
    local tries=0
    until pidfile_claim "$1"; do
        tries=$((tries + 1))
        [ "$tries" -lt 100 ] || return 1
        sleep 0.2 2> /dev/null || sleep 1
    done
}

reconcile_locked() {
    lock_acquire "$RUN_DIR/reconcile.pid" || return 1
    reconcile
    rm -f "$RUN_DIR/reconcile.pid"
}

daemon_pid() {
    pidfile_alive "$RUN_DIR/daemon.pid"
}

daemon_running() {
    daemon_pid > /dev/null
}

monitor_enabled() {
    local m
    cfg_get m monitor
    [ "$m" != 0 ]
}

start_daemon() {
    local n=0
    daemon_running && return 0
    if command -v setsid > /dev/null 2>&1; then
        setsid "$SH_BIN" "$MODDIR/watcher.sh" < /dev/null > /dev/null 2>&1 &
    else
        "$SH_BIN" "$MODDIR/watcher.sh" < /dev/null > /dev/null 2>&1 &
    fi
    while [ "$n" -lt 15 ]; do
        daemon_running && return 0
        sleep 0.2 2> /dev/null || sleep 1
        n=$((n + 1))
    done
    daemon_running
}

kill_monitor() {
    local pid
    if pid=$(pidfile_alive "$RUN_DIR/monitor.pid"); then
        kill "$pid" 2> /dev/null
    fi
    rm -f "$RUN_DIR/monitor.pid"
}

stop_daemon() {
    local pid n=0
    if pid=$(daemon_pid); then
        kill "$pid" 2> /dev/null
        while [ "$n" -lt 5 ] && kill -0 "$pid" 2> /dev/null; do
            sleep 1
            n=$((n + 1))
        done
        kill -9 "$pid" 2> /dev/null
    fi
    kill_monitor
    return 0
}
