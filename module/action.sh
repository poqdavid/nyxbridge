#!/system/bin/sh
# Manager "Action" button: make sure the watcher runs, re-check, summarize.
NYX_MODDIR=${MODDIR:-${0%/*}}
[ -f "${NYX_MODDIR}/ctl.sh" ] || NYX_MODDIR=/data/adb/modules/nyxbridge

/system/bin/sh "${NYX_MODDIR}/ctl.sh" start > /dev/null 2>&1
/system/bin/sh "${NYX_MODDIR}/ctl.sh" report
