#!/bin/sh
PERSISTENT_DIR=/data/adb/nyxbridge

ui_print " "
ui_print "  NyxBridge"
ui_print "  phone address on VirtualAP's hotspot bridge"
ui_print " "

if [ -z "$KSU" ]; then
    abort '[!] NyxBridge is for KernelSU / KernelSU-Next only.'
fi

if [ -f ${MODPATH}/verify.sh ]; then
    . ${MODPATH}/verify.sh
    if nyx_verify "${MODPATH}"; then
        ui_print "  [+] Integrity check passed"
    else
        ui_print " "
        ui_print "  [!] Integrity check FAILED - the module is corrupted or has"
        ui_print "      been tampered with. Aborting installation."
        rm -rf ${MODPATH}
        exit 1
    fi
fi

nyxbridge_config_check() {
    ui_print " "
    ui_print "****************************************"
    ui_print "   An existing NyxBridge config folder  "
    ui_print "   was found                              "
    ui_print "****************************************"
    ui_print "     Do you want to reset settings?     "
    ui_print "****************************************"
    ui_print "  Volume Up (+): Reset to default"
    ui_print "  Volume Down (-): Keep current settings"
    ui_print " "
    ui_print "  Keep current settings in 10 seconds"
    ui_print "****************************************"
    local timeout=10
    local start_time=$(date +%s)
    while true; do
        local current_time=$(date +%s)
        if [ $((current_time - start_time)) -ge $timeout ]; then
            ui_print "[-] Timeout: keeping current settings"
            break
        fi
        local key_event=$(timeout 0.5 getevent -l 2> /dev/null)
        if echo "$key_event" | grep -q "KEY_VOLUMEUP"; then
            ui_print "[-] Resetting NyxBridge settings to default..."
            rm -rf ${PERSISTENT_DIR}
            break
        elif echo "$key_event" | grep -q "KEY_VOLUMEDOWN"; then
            ui_print "[-] Keeping current settings"
            break
        fi
    done
}

if [ -d ${PERSISTENT_DIR} ]; then
    nyxbridge_config_check
fi

ui_print "[-] Preparing NyxBridge persistent directory"
mkdir -p ${PERSISTENT_DIR}
chmod 700 ${PERSISTENT_DIR}
if [ ! -f ${PERSISTENT_DIR}/config.sh ]; then
    cat ${MODPATH}/config.sh > ${PERSISTENT_DIR}/config.sh
else
    [ -n "$(tail -c1 "${PERSISTENT_DIR}/config.sh")" ] && echo "" >> "${PERSISTENT_DIR}/config.sh"
    while IFS= read -r line; do
        key=${line%%=*}
        case "$key" in '' | '#'* | "$line") continue ;; esac
        grep -q "^${key}=" "${PERSISTENT_DIR}/config.sh" || echo "$line" >> "${PERSISTENT_DIR}/config.sh"
    done < ${MODPATH}/config.sh
fi
chmod 600 ${PERSISTENT_DIR}/config.sh

if [ ! -d /data/local/virtualap ]; then
    ui_print "[!] VirtualAP's backend was not found in /data/local/virtualap"
    ui_print "    Open the VirtualAP app once so it installs its backend"
fi

chmod 644 ${MODPATH}/service.sh ${MODPATH}/action.sh ${MODPATH}/uninstall.sh \
    ${MODPATH}/utils.sh ${MODPATH}/watcher.sh ${MODPATH}/ctl.sh ${MODPATH}/config.sh

rm ${MODPATH}/customize.sh
rm -f ${MODPATH}/verify.sh

ui_print "[-] Done. Reboot, then start VirtualAP in managed mode."
ui_print "    Open the module's WebUI any time to check status or change settings."
# EOF
