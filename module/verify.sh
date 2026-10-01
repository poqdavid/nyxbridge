#!/system/bin/sh
#
# verify.sh - install-time integrity check for NyxBridge.
#

nyx_verify() {
    _root=$1
    [ -d "$_root" ] || {
        echo "verify: '$_root' not found"
        return 1
    }

    if command -v sha256sum > /dev/null 2>&1; then
        _sha='sha256sum'
    elif command -v shasum > /dev/null 2>&1; then
        _sha='shasum -a 256'
    else
        echo "verify: no sha256 tool available, skipping integrity check"
        find "$_root" -type f -name '*.sha256' -delete 2> /dev/null
        return 0
    fi

    if [ -z "$(find "$_root" -type f -name '*.sha256' 2> /dev/null | head -n1)" ]; then
        echo "verify: no checksums in this build, skipping integrity check"
        return 0
    fi

    _marker="$_root/.nyx_verify_failed"
    rm -f "$_marker"

    find "$_root" -type f ! -name '*.sha256' 2> /dev/null | while IFS= read -r _f; do
        [ "$_f" = "$_marker" ] && continue
        _hf="$_f.sha256"
        if [ ! -f "$_hf" ]; then
            echo "verify: missing hash for $_f"
            : > "$_marker"
            continue
        fi
        _want=$(cat "$_hf" 2> /dev/null)
        _got=$($_sha "$_f" 2> /dev/null | awk '{print $1}')
        if [ -z "$_got" ] || [ "$_want" != "$_got" ]; then
            echo "verify: hash mismatch for $_f"
            : > "$_marker"
        fi
    done

    _rc=0
    [ -f "$_marker" ] && _rc=1
    rm -f "$_marker"

    find "$_root" -type f -name '*.sha256' -delete 2> /dev/null

    return $_rc
}
