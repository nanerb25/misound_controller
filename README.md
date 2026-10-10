# MiSound Live Controller v2 (Termux + Frida)

This is a runtime-only controller for the exact `libmisound.so` build analyzed in the accompanying conversation. It does not modify the on-disk library.

## Requirements
- Root access on Android.
- Android ARM64 Frida server and Termux `frida-tools`/Python bindings with matching versions.
- The PID must be the process that maps this exact `libmisound.so` build. The agent checks offsets and AArch64 prologue words before hooking.

## Start
1. Keep `misound_agent.js` and `misound_control_termux.py` together.
2. Start your matching Frida server as root (if not already running).
3. Find the PID:
   ```sh
   su -c 'for f in /proc/[0-9]*/maps; do grep -q libmisound.so "$f" 2>/dev/null && { p=${f#/proc/}; p=${p%/maps}; echo "PID=$p CMD=$(tr "\\000" " " < /proc/$p/cmdline)"; }; done'
   ```
4. Run:
   ```sh
   python misound_control_termux.py PID
   ```

## Commands
- `nativeoff`, `nativeon`: native parameter 19; the chosen state is reapplied only when a new handler appears or playback callbacks resume after a gap of at least 750 ms. There are no periodic setter calls while music continues.
- `preset bass`, `preset treble`: conservative EQ-array presets (maximum boost +2 dB).
- `preset clear`: sets all 10 EQ values to 0 dB; this is flat EQ, not necessarily the device's factory EQ.
- `stockeq`: restores the EQ snapshot captured for the current handler before a preset is changed.
- `eqshow`: reads parameter ID 3 through the library's `getParams` path.
- `eq <10 comma-separated values>`: set custom gains, constrained to +/-6 dB.
- `hardoff`: optional direct playback PCM bypass; use only if the native control is insufficient.
- `passthrough`: clears the direct bypass flag.
- `status`: runtime status.

## Important limitations
- This is a reverse-engineered, build-specific experiment, not a vendor-supported API. It is not tested against the live phone from this environment.
- The ten frequencies shown (31, 62, 125, 250, 500, 1k, 2k, 4k, 8k, 16k Hz) are a conventional assumed display order; confirm by listening/testing. The library may use a seven-band fallback if the ten-band resource module is absent.
- EQ values are sent as ten float words to the native parameter-3 array path. The code validates binary signatures but cannot prove the active resource layout or gain semantics on every device. Start with `eqshow`, then `preset bass`/`preset treble` at low volume.
- The stock snapshot is per handler and held in the Frida agent's memory. If the agent is restarted after an EQ change, the old snapshot is lost. `stockeq` restores the snapshot captured for the current handler, not a file-backed factory backup.
- Native/EQ reapplication is event-driven only (new handler or callback gap) and queued asynchronously with a short delay so the setter is not called directly on the real-time audio callback thread. Thread-safety is still not guaranteed by the vendor. If audio glitches/crashes, detach only after clearing `hardoff`, or restart the audio service/device as a recovery path.
- Keep the agent attached for auto-reapply; detaching stops monitoring. Auto-reapply catches new handlers and playback-resume gaps only; it does not poll or repeatedly call setters while callbacks are active. It cannot enforce a state while the target process is dead or after Frida detaches.
