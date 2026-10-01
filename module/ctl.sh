#!/system/bin/sh
# NyxBridge - control commands for the WebUI and the Action button.
#
#   ctl.sh status            key=value status (changes nothing)
#   ctl.sh apply             re-check now, then print status
#   ctl.sh set KEY VALUE     change one setting; bridge settings apply at once
#   ctl.sh start             start the watcher if it is not running
#   ctl.sh log               last 200 log lines
#   ctl.sh report            re-check now, then print a readable summary
#
# shellcheck disable=SC3043

MODDIR=${0%/*}
. "$MODDIR/utils.sh"

init_dirs || {
    echo 'Cannot create the module data directories' >&2
    exit 1
}

print_status() {
    local gwinfo base subnet host_ip addr4=0 rule4=0 addrs6='' rules6 br
    load_config
    load_va
    br=$VA_BRIDGE
    if daemon_running; then echo 'daemon=running'; else echo 'daemon=stopped'; fi
    if monitor_enabled; then echo 'monitor=1'; else echo 'monitor=0'; fi
    if module_flagged; then echo 'module_disabled=1'; else echo 'module_disabled=0'; fi
    echo "enabled=$CFG_ENABLED"
    echo "ipv6=$CFG_IPV6"
    echo "host_octet=$CFG_HOST"
    echo "rule_pref=$CFG_PREF"
    echo "va_mode=$VA_MODE"
    echo "bridge=$br"
    echo "gateway=$VA_GW"
    if [ -d "$SYS_NET/$br" ]; then echo 'bridge_present=1'; else echo 'bridge_present=0'; fi
    if gwinfo=$(parse_gw "$VA_GW"); then
        base=${gwinfo% *}
        subnet="$base.0/24"
        host_ip="$base.$CFG_HOST"
        echo "subnet=$subnet"
        echo "host_ip=$host_ip"
        "$IP_BIN" -4 -o addr show dev "$br" 2> /dev/null | grep -Fq " inet $host_ip/24 " && addr4=1
        rule_line_present 4 "from all to $subnet lookup main" && rule4=1
    fi
    echo "addr4=$addr4"
    echo "rule4=$rule4"
    if [ -d "$SYS_NET/$br" ]; then
        addrs6=$("$IP_BIN" -6 -o addr show dev "$br" scope global 2> /dev/null \
            | awk '{ for (i = 1; i < NF; i++) if ($i == "inet6") print $(i + 1) }' | tr '\n' ' ')
    fi
    echo "addrs6=$addrs6"
    rules6=$(rule_count 6)
    echo "rules6=$rules6"
    echo "state=$(kv_get "$STATUS" state)"
    echo "reason=$(kv_get "$STATUS" reason)"
    echo "reason_code=$(kv_get "$STATUS" reason_code)"
    echo "reason_arg=$(kv_get "$STATUS" reason_arg)"
    echo "checked=$(kv_get "$STATUS" time)"
}

print_report() {
    local out
    out=$(print_status)
    get() { printf '%s\n' "$out" | sed -n "s/^$1=//p" | head -n 1; }
    echo "***************************************"
    echo "  NyxBridge - status"
    echo "***************************************"
    case "$(get state)" in
        active) echo "[-] Active on $(get bridge)" ;;
        error) echo "[!] Problem: $(get reason)" ;;
        *) echo "[-] Idle: $(get reason)" ;;
    esac
    if [ "$(get monitor)" = 1 ]; then
        echo "[-] Monitoring: on (watcher $(get daemon))"
    else
        echo "[-] Monitoring: off - re-check here or in the WebUI after starting or stopping the hotspot"
    fi
    echo "[-] VirtualAP: $(get va_mode) (gateway $(get gateway))"
    if [ "$(get addr4)" = 1 ]; then
        echo "[-] Phone: $(get host_ip)/24 on $(get bridge)"
    else
        echo "[-] Phone: no address on the bridge"
    fi
    if [ "$(get rule4)" = 1 ]; then
        echo "[-] Rule: $(get rule_pref): to $(get subnet) lookup main"
    else
        echo "[-] Rule: not installed"
    fi
    if [ "$(get ipv6)" = 1 ]; then
        echo "[-] IPv6: on - addresses: $(get addrs6); rules: $(get rules6)"
    else
        echo "[-] IPv6: off"
    fi
    echo "[-] Checked: $(get checked)"
}

case "${1:-}" in
    status)
        print_status
        ;;
    apply)
        reconcile_locked || {
            echo 'Another check is still running; try again' >&2
            exit 1
        }
        print_status
        ;;
    set)
        key=${2:-}
        val=${3:-}
        reapply=0
        case "$key" in
            monitor)
                case "$val" in 0 | 1) ;; *)
                    echo 'monitor must be 0 or 1' >&2
                    exit 2
                    ;;
                esac
                lock_acquire "$RUN_DIR/monitor.lock" || {
                    echo 'Another change is still running; try again' >&2
                    exit 1
                }
                rc=0
                if ! config_set monitor "$val"; then
                    echo 'Could not save the setting' >&2
                    rc=1
                elif [ "$val" = 1 ]; then
                    log_msg "Monitoring turned on"
                    if ! start_daemon; then
                        echo 'Monitoring is on, but the watcher did not start' >&2
                        rc=1
                    fi
                else
                    log_msg "Monitoring turned off"
                    stop_daemon
                fi
                rm -f "$RUN_DIR/monitor.lock"
                [ "$rc" = 0 ] || exit 1
                print_status
                exit 0
                ;;
            enabled | ipv6)
                case "$val" in 0 | 1) reapply=1 ;; *)
                    echo "$key must be 0 or 1" >&2
                    exit 2
                    ;;
                esac
                ;;
            host_octet)
                is_num "$val" 1 254 || {
                    echo 'The last number must be between 1 and 254' >&2
                    exit 2
                }
                load_va
                if gwinfo=$(parse_gw "$VA_GW") && [ "${gwinfo#* }" = "$val" ]; then
                    echo "That is VirtualAP's gateway address; pick another number" >&2
                    exit 2
                fi
                reapply=1
                ;;
            webui_theme)
                case "$val" in system | light | dark) ;; *)
                    echo 'webui_theme must be system, light or dark' >&2
                    exit 2
                    ;;
                esac
                ;;
            webui_monet | webui_fullscreen)
                case "$val" in 0 | 1) ;; *)
                    echo "$key must be 0 or 1" >&2
                    exit 2
                    ;;
                esac
                ;;
            *)
                echo "Unknown setting: $key" >&2
                exit 2
                ;;
        esac
        config_set "$key" "$val" || {
            echo 'Could not save the setting' >&2
            exit 1
        }
        [ "$reapply" = 1 ] || exit 0
        log_msg "Setting changed: $key=$val"
        reconcile_locked || {
            echo 'Saved, but another check is still running' >&2
            exit 1
        }
        print_status
        ;;
    start)
        if monitor_enabled; then start_daemon; fi
        print_status
        ;;
    log)
        if [ -f "$LOG" ]; then tail -n 200 "$LOG"; fi
        ;;
    report)
        reconcile_locked
        print_report
        ;;
    *)
        echo 'Usage: ctl.sh status | apply | set KEY VALUE | start | log | report' >&2
        exit 2
        ;;
esac
