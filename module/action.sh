#!/system/bin/sh
# Manager "Action" button: make sure the watcher runs, re-check, summarize.
NYX_MODDIR=${MODDIR:-${0%/*}}
[ -f "${NYX_MODDIR}/bin/nyxbridge" ] || NYX_MODDIR=/data/adb/modules/nyxbridge

"${NYX_MODDIR}/bin/nyxbridge" start > /dev/null 2>&1
exec "${NYX_MODDIR}/bin/nyxbridge" report
