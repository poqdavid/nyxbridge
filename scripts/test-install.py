#!/usr/bin/env python3
"""Installer checks: customize.sh refuses what it can't support before it
touches anything.

customize.sh runs with KernelSU's ui_print/abort stubbed, and every /data path
in it moved under a temporary directory, so the test never reads or writes the
machine's own /data. A supported device gets past the checks to the first real
install step (preparing /data/adb/nyxbridge); a refused one stops before it.
"""
from pathlib import Path
import os
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
PASSED_CHECKS = "[-] Preparing NyxBridge persistent directory"


def install(arch=None, abi=None, ksu=True):
    """Run customize.sh; returns (exit code, output, whether it created its data directory)."""
    with tempfile.TemporaryDirectory(prefix="nyx-install-") as tmp:
        tmp = Path(tmp)
        script = (ROOT / "module/customize.sh").read_text()
        script = script.replace("/data/", f"{tmp}/data/")
        (tmp / "customize.sh").write_text(script)
        (tmp / "modpath").mkdir()
        (tmp / "bin").mkdir()
        if abi is not None:
            getprop = tmp / "bin/getprop"
            getprop.write_text(f'#!/bin/sh\n[ "$1" = ro.product.cpu.abi ] && echo {abi}\n')
            getprop.chmod(0o755)
        env = {"PATH": f"{tmp}/bin:/usr/bin:/bin", "MODPATH": str(tmp / "modpath"), "TMPDIR": str(tmp)}
        if ksu:
            env["KSU"] = "true"
        if arch is not None:
            env["ARCH"] = arch
        run = subprocess.run(
            ["sh", "-c", 'ui_print() { printf "%s\\n" "$*"; }; abort() { printf "%s\\n" "$*"; exit 1; }; . "$0"', str(tmp / "customize.sh")],
            env=env, capture_output=True, text=True, timeout=30,
        )
        return run.returncode, run.stdout + run.stderr, os.path.isdir(tmp / "data/adb/nyxbridge")


class InstallChecks(unittest.TestCase):
    def assert_passed(self, result):
        _, out, touched = result
        self.assertIn(PASSED_CHECKS, out)
        self.assertNotIn("needs an arm64 device", out)
        self.assertTrue(touched)

    def assert_refused(self, result, shown):
        code, out, touched = result
        self.assertNotEqual(code, 0)
        self.assertIn(f"needs an arm64 device (this one is '{shown}')", out)
        self.assertNotIn(PASSED_CHECKS, out)
        self.assertFalse(touched)

    def test_arm64_passes(self):
        self.assert_passed(install(arch="arm64"))

    def test_other_cpus_are_refused(self):
        for arch in ["arm", "x86", "x64", "riscv64"]:
            with self.subTest(arch=arch):
                self.assert_refused(install(arch=arch), arch)

    def test_getprop_is_the_fallback(self):
        self.assert_passed(install(abi="arm64-v8a"))
        for abi in ["armeabi-v7a", "x86_64", "x86"]:
            with self.subTest(abi=abi):
                self.assert_refused(install(abi=abi), abi)

    def test_unknown_cpu_is_refused(self):
        self.assert_refused(install(), "unknown")

    def test_needs_kernelsu(self):
        code, out, touched = install(arch="arm64", ksu=False)
        self.assertNotEqual(code, 0)
        self.assertIn("for KernelSU / KernelSU-Next only", out)
        self.assertNotIn(PASSED_CHECKS, out)
        self.assertFalse(touched)


if __name__ == "__main__":
    unittest.main()
