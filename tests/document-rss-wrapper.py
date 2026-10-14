"""Measure only the spawned synthetic document helper using macOS wait4.

stdio is inherited: no document files, text logs, shell, network or sysctl.
"""
import json
import os
import sys
import time

if sys.platform != "darwin" or len(sys.argv) < 2:
    raise SystemExit(2)
started = time.monotonic_ns()
pid = os.posix_spawn(sys.argv[1], sys.argv[1:], dict(os.environ))
_, status, usage = os.wait4(pid, 0)
# Darwin ru_maxrss is bytes, unlike Linux's KiB. This script is macOS-only.
sys.stderr.write("\nCONTEXT_DOCUMENT_RUSAGE " + json.dumps({"helperPeakRSSBytes": int(usage.ru_maxrss), "helperWallMs": round((time.monotonic_ns() - started) / 1_000_000, 2)}) + "\n")
sys.stderr.flush()
raise SystemExit(os.waitstatus_to_exitcode(status))
