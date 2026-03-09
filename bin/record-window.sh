#!/bin/bash
#
# record-window.sh — Screen recording helper for AI-driven demos.
#
# Records Chrome windows using macOS screencapture with window-level targeting.
# Uses CGWindowList to find Chrome windows by title, then records them with
# `screencapture -v -l<windowid>` — captures the window regardless of z-order.
#
# Usage:
#   record-window.sh start <output-dir> [--viewport WxH]
#   record-window.sh switch <persona>
#   record-window.sh stop
#   record-window.sh position
#   record-window.sh split <output-dir> <action-log.jsonl>
#
# Environment:
#   <PERSONA>_WINDOW_TITLE — window title substring for each persona
#                            (e.g. ADMIN_WINDOW_TITLE, BUYER_WINDOW_TITLE, RECIPIENT_WINDOW_TITLE)
#
# The script stores state in <output-dir>/.recording-state/ so that
# start/switch/stop calls can coordinate across separate invocations.

set -euo pipefail

COMMAND="${1:-}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Default viewport (logical pixels)
DEFAULT_VIEWPORT="1280x800"

die() {
    echo "ERROR: $*" >&2
    exit 1
}

# Get current epoch in milliseconds.
_epoch_ms() {
    perl -MTime::HiRes -e 'printf "%d\n", Time::HiRes::time()*1000'
}

# Read one or more fields from a JSON file. Returns space-separated values.
# Usage: _json_read <file> <key1> [key2...]
_json_read() {
    local file="$1"; shift
    python3 -c "
import json, sys
d = json.load(open(sys.argv[1]))
for k in sys.argv[2:]:
    print(d[k])
" "$file" "$@"
}

# JSON-escape a string for safe interpolation into JSONL.
_json_escape() {
    python3 -c "import json,sys; print(json.dumps(sys.argv[1]))" "$1"
}

# Read the first persona name from the session state file.
_session_first_persona() {
    python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['personas'][0])" "$1"
}

# Atomically update a key in the config file.
# Removes ALL existing lines for the key and appends the new value.
# This prevents duplicate lines that cause `source` to read stale state.
_config_set() {
    local config_file="$1"
    local key="$2"
    local value="$3"
    # Remove all lines starting with KEY= (handles duplicates)
    sed -i '' "/^${key}=/d" "$config_file"
    # Append the new value
    echo "${key}=${value}" >> "$config_file"
}

# Get the state directory for the current recording session
get_state_dir() {
    local output_dir="$1"
    echo "${output_dir}/.recording-state"
}

# Find a Chrome Beta window ID by title substring using CGWindowList.
# Returns the CGWindowID (integer) or empty string if not found.
find_window_id() {
    local title_match="$1"
    swift -e "
import CoreGraphics
import Foundation
let match = \"${title_match}\"
if let windowList = CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as? [[String: Any]] {
    for w in windowList {
        let owner = w[\"kCGWindowOwnerName\"] as? String ?? \"\"
        if owner.contains(\"Chrome\") {
            let name = w[\"kCGWindowName\"] as? String ?? \"\"
            let bounds = w[\"kCGWindowBounds\"] as? [String: Any] ?? [:]
            let width = bounds[\"Width\"] as? CGFloat ?? 0
            if width > 500 && name.contains(match) {
                let wid = w[\"kCGWindowNumber\"] as? Int ?? 0
                print(wid)
                exit(0)
            }
        }
    }
}
" 2>/dev/null
}

# Find window bounds (x,y,w,h) by window ID
find_window_bounds() {
    local wid="$1"
    swift -e "
import CoreGraphics
import Foundation
let targetWID = ${wid}
if let windowList = CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as? [[String: Any]] {
    for w in windowList {
        let num = w[\"kCGWindowNumber\"] as? Int ?? 0
        if num == targetWID {
            let bounds = w[\"kCGWindowBounds\"] as? [String: Any] ?? [:]
            let x = Int(bounds[\"X\"] as? CGFloat ?? 0)
            let y = Int(bounds[\"Y\"] as? CGFloat ?? 0)
            let width = Int(bounds[\"Width\"] as? CGFloat ?? 0)
            let height = Int(bounds[\"Height\"] as? CGFloat ?? 0)
            print(\"\(width)x\(height)+\(x)+\(y)\")
            exit(0)
        }
    }
}
" 2>/dev/null
}

# Resize a Chrome window via MCP's resize_page. This is a best-effort
# helper — the demo command can also resize via MCP directly.
resize_window_by_id() {
    local wid="$1"
    local width="$2"
    local height="$3"
    # Use AppleScript to resize by targeting all Chrome Beta processes
    osascript -e "
tell application \"System Events\"
    repeat with proc in (every process whose name contains \"Chrome Beta\")
        repeat with w in windows of proc
            try
                -- We can't match by CGWindowID in AppleScript, so resize all
                set size of w to {${width}, ${height}}
            end try
        end repeat
    end repeat
end tell" 2>/dev/null || true
}

cmd_start() {
    local output_dir="${2:-}"
    local viewport="${DEFAULT_VIEWPORT}"

    # Parse optional flags
    shift 2 || true
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --viewport) viewport="$2"; shift 2 ;;
            *) die "Unknown flag: $1" ;;
        esac
    done

    [[ -z "$output_dir" ]] && die "Usage: record-window.sh start <output-dir> [--viewport WxH]"

    local vp_width="${viewport%x*}"
    local vp_height="${viewport#*x}"

    # Discover personas from *_WINDOW_TITLE env vars
    local personas=()
    local persona_titles=()
    while IFS= read -r var; do
        [[ -z "$var" ]] && continue
        local name="${var%%_WINDOW_TITLE=*}"
        name=$(echo "$name" | tr '[:upper:]' '[:lower:]')
        local title="${var#*_WINDOW_TITLE=}"
        personas+=("$name")
        persona_titles+=("$title")
    done < <(env | grep '_WINDOW_TITLE=' | sort)

    # Fallback: if no env vars set, use admin with default title
    if [[ ${#personas[@]} -eq 0 ]]; then
        personas=("admin")
        persona_titles=("next-admin")
    fi

    local first_persona="${personas[0]}"

    # Create state directory
    local state_dir
    state_dir=$(get_state_dir "$output_dir")
    mkdir -p "$state_dir"

    echo "Looking for Chrome windows..."
    echo "Personas: ${personas[*]}"

    # Find window IDs for each persona
    local first_wid=""
    local config_lines=""
    config_lines+="OUTPUT_DIR=\"${output_dir}\"\n"
    config_lines+="VP_WIDTH=\"${vp_width}\"\n"
    config_lines+="VP_HEIGHT=\"${vp_height}\"\n"
    config_lines+="PERSONAS=\"${personas[*]}\"\n"

    for i in "${!personas[@]}"; do
        local p="${personas[$i]}"
        local title="${persona_titles[$i]}"
        local wid
        wid=$(find_window_id "$title") || true

        if [[ -n "$wid" ]]; then
            echo "  ${p} window: WID=${wid} (matching '${title}')"
            local bounds
            bounds=$(find_window_bounds "$wid")
            echo "  ${p} bounds: ${bounds}"

            # Check if window is fullscreen (warn if not)
            local screen_dims
            screen_dims=$(swift -e '
import AppKit
if let screen = NSScreen.main {
    let f = screen.frame
    print("\(Int(f.width))x\(Int(f.height))")
}
' 2>/dev/null)
            if [[ -n "$screen_dims" && -n "$bounds" ]]; then
                local screen_w="${screen_dims%x*}"
                local screen_h="${screen_dims#*x}"
                local win_w="${bounds%x*}"
                win_w="${win_w%+*}"
                if [[ "$win_w" -lt "$screen_w" ]]; then
                    echo "  WARNING: Window is not fullscreen (${bounds} vs screen ${screen_dims})"
                    echo "  For cleaner recordings, press F11 in Chrome or launch with --chromeArg=--start-fullscreen"
                fi
            fi
        else
            if [[ "$p" == "$first_persona" ]]; then
                echo "WARNING: Could not find ${first_persona} window matching '${title}'"
                echo "Available Chrome windows:"
                swift -e '
import CoreGraphics
import Foundation
if let windowList = CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as? [[String: Any]] {
    for w in windowList {
        let owner = w["kCGWindowOwnerName"] as? String ?? ""
        if owner.contains("Chrome") {
            let name = w["kCGWindowName"] as? String ?? "<unnamed>"
            let bounds = w["kCGWindowBounds"] as? [String: Any] ?? [:]
            let width = bounds["Width"] as? CGFloat ?? 0
            if width > 500 {
                let wid = w["kCGWindowNumber"] as? Int ?? 0
                print("  WID:\(wid) \(Int(width))x\(Int(bounds["Height"] as? CGFloat ?? 0)) \"\(name)\"")
            }
        }
    }
}' 2>/dev/null
                die "Cannot start recording without ${first_persona} window"
            fi
            echo "  ${p} window not found yet (will search on switch)"
        fi

        config_lines+="PERSONA_${p}_TITLE=\"${title}\"\n"
        config_lines+="PERSONA_${p}_WID=\"${wid:-}\"\n"

        # Track the first persona's window ID for initial recording
        if [[ "$p" == "$first_persona" && -n "$wid" ]]; then
            first_wid="$wid"
        fi
    done

    config_lines+="ACTIVE_PERSONA=\"${first_persona}\"\n"

    # Write config
    echo -e "$config_lines" > "${state_dir}/config"

    # Start recording the first persona's window
    local recording_file="${output_dir}/raw-recording.mov"
    echo "Starting screen recording of ${first_persona} window (WID ${first_wid})..."

    screencapture -v -C -k -x "-l${first_wid}" "$recording_file" &
    local sc_pid=$!
    echo "$sc_pid" > "${state_dir}/screencapture.pid"

    # Verify recording started
    sleep 1
    if ! kill -0 "$sc_pid" 2>/dev/null; then
        echo "WARNING: screencapture may not have started" >&2
        return 1
    fi

    echo "Recording started (PID ${sc_pid})"
    echo "Output: ${recording_file}"
    echo "SCREENCAPTURE_PID=${sc_pid}"
}

cmd_switch() {
    local persona="${2:-}"
    [[ -z "$persona" ]] && die "Usage: record-window.sh switch <persona>"

    local state_dir="${RECORDING_STATE_DIR:-}"
    if [[ -z "$state_dir" ]]; then
        if [[ -n "${RECORDING_OUTPUT_DIR:-}" ]]; then
            state_dir=$(get_state_dir "$RECORDING_OUTPUT_DIR")
        else
            die "Set RECORDING_OUTPUT_DIR or RECORDING_STATE_DIR"
        fi
    fi

    [[ -f "${state_dir}/config" ]] || die "No active recording session found at ${state_dir}"
    source "${state_dir}/config"

    if [[ "$persona" == "$ACTIVE_PERSONA" ]]; then
        echo "Already recording ${persona}, no switch needed"
        return 0
    fi

    echo "Switching to ${persona}..."

    # Stop the current recording
    if [[ -f "${state_dir}/screencapture.pid" ]]; then
        local old_pid
        old_pid=$(cat "${state_dir}/screencapture.pid")
        if kill -0 "$old_pid" 2>/dev/null; then
            kill -INT "$old_pid" 2>/dev/null || true
            local waited=0
            while kill -0 "$old_pid" 2>/dev/null && [[ $waited -lt 5 ]]; do
                sleep 0.5
                waited=$((waited + 1))
            done
        fi
    fi

    # Look up persona config dynamically
    local title_var="PERSONA_${persona}_TITLE"
    local wid_var="PERSONA_${persona}_WID"
    local target_title="${!title_var:-}"
    local target_wid="${!wid_var:-}"

    [[ -z "$target_title" ]] && die "Unknown persona: ${persona}. Known: ${PERSONAS}"

    # If we don't have the window ID yet, search for it now
    if [[ -z "$target_wid" ]]; then
        echo "  Searching for ${persona} window matching '${target_title}'..."
        target_wid=$(find_window_id "$target_title")
        if [[ -z "$target_wid" ]]; then
            echo "WARNING: Could not find window matching '${target_title}'"
            echo "  Available Chrome windows:"
            swift -e '
import CoreGraphics
import Foundation
if let windowList = CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as? [[String: Any]] {
    for w in windowList {
        let owner = w["kCGWindowOwnerName"] as? String ?? ""
        if owner.contains("Chrome") {
            let name = w["kCGWindowName"] as? String ?? "<unnamed>"
            let bounds = w["kCGWindowBounds"] as? [String: Any] ?? [:]
            let width = bounds["Width"] as? CGFloat ?? 0
            if width > 500 {
                let wid = w["kCGWindowNumber"] as? Int ?? 0
                print("    WID:\(wid) \(Int(width))x\(Int(bounds["Height"] as? CGFloat ?? 0)) \"\(name)\"")
            }
        }
    }
}' 2>/dev/null
            die "Cannot switch to ${persona}: window not found"
        fi
        echo "  Found: WID=${target_wid}"
        # Cache the window ID for future switches
        _config_set "${state_dir}/config" "PERSONA_${persona}_WID" "\"${target_wid}\""
    fi

    # Determine recording file — each persona segment gets a numbered file
    local segment_count
    segment_count=$(ls "${OUTPUT_DIR}"/*.mov 2>/dev/null | wc -l | tr -d ' ')
    local recording_file="${OUTPUT_DIR}/segment-${segment_count}-${persona}.mov"

    echo "  Starting recording of ${persona} window (WID ${target_wid})..."
    screencapture -v -C -k -x "-l${target_wid}" "$recording_file" &
    local sc_pid=$!
    echo "$sc_pid" > "${state_dir}/screencapture.pid"

    # Update active persona
    _config_set "${state_dir}/config" "ACTIVE_PERSONA" "\"${persona}\""

    sleep 0.5
    echo "Now recording: ${persona} (PID ${sc_pid})"
}

cmd_stop() {
    local state_dir="${RECORDING_STATE_DIR:-}"
    if [[ -z "$state_dir" ]]; then
        if [[ -n "${RECORDING_OUTPUT_DIR:-}" ]]; then
            state_dir=$(get_state_dir "$RECORDING_OUTPUT_DIR")
        else
            die "Set RECORDING_OUTPUT_DIR or RECORDING_STATE_DIR"
        fi
    fi

    [[ -f "${state_dir}/screencapture.pid" ]] || die "No active recording (no PID file)"

    local pid
    pid=$(cat "${state_dir}/screencapture.pid")

    if kill -0 "$pid" 2>/dev/null; then
        echo "Stopping recording (PID ${pid})..."
        kill -INT "$pid" 2>/dev/null || true

        local waited=0
        while kill -0 "$pid" 2>/dev/null && [[ $waited -lt 10 ]]; do
            sleep 1
            waited=$((waited + 1))
        done

        if kill -0 "$pid" 2>/dev/null; then
            echo "Force-killing screencapture..."
            kill -9 "$pid" 2>/dev/null || true
        fi

        echo "Recording stopped"
    else
        echo "Recording process ${pid} already exited"
    fi

    rm -f "${state_dir}/screencapture.pid"

    # List all recording segments
    source "${state_dir}/config"
    echo "Recording segments:"
    ls -la "${OUTPUT_DIR}"/*.mov 2>/dev/null || echo "  (none)"
}

cmd_pause() {
    local state_dir="${RECORDING_STATE_DIR:-}"
    if [[ -z "$state_dir" ]]; then
        if [[ -n "${RECORDING_OUTPUT_DIR:-}" ]]; then
            state_dir=$(get_state_dir "$RECORDING_OUTPUT_DIR")
        else
            die "Set RECORDING_OUTPUT_DIR or RECORDING_STATE_DIR"
        fi
    fi

    [[ -f "${state_dir}/config" ]] || die "No active recording session found at ${state_dir}"
    source "${state_dir}/config"

    # Check if already paused
    if [[ "${PAUSED:-false}" == "true" ]]; then
        echo "Recording is already paused"
        return 0
    fi

    # Stop the current screencapture
    if [[ -f "${state_dir}/screencapture.pid" ]]; then
        local pid
        pid=$(cat "${state_dir}/screencapture.pid")
        if kill -0 "$pid" 2>/dev/null; then
            kill -INT "$pid" 2>/dev/null || true
            local waited=0
            while kill -0 "$pid" 2>/dev/null && [[ $waited -lt 5 ]]; do
                sleep 0.5
                waited=$((waited + 1))
            done
        fi
        rm -f "${state_dir}/screencapture.pid"
    fi

    # Mark as paused
    _config_set "${state_dir}/config" "PAUSED" "true"

    echo "Recording paused (was recording ${ACTIVE_PERSONA})"
    echo "Use 'resume' to continue recording."
}

cmd_resume() {
    local state_dir="${RECORDING_STATE_DIR:-}"
    if [[ -z "$state_dir" ]]; then
        if [[ -n "${RECORDING_OUTPUT_DIR:-}" ]]; then
            state_dir=$(get_state_dir "$RECORDING_OUTPUT_DIR")
        else
            die "Set RECORDING_OUTPUT_DIR or RECORDING_STATE_DIR"
        fi
    fi

    [[ -f "${state_dir}/config" ]] || die "No active recording session found at ${state_dir}"
    source "${state_dir}/config"

    # Check if actually paused
    if [[ "${PAUSED:-false}" != "true" ]]; then
        echo "Recording is not paused"
        return 0
    fi

    # Look up the active persona's window ID
    local wid_var="PERSONA_${ACTIVE_PERSONA}_WID"
    local target_wid="${!wid_var:-}"

    if [[ -z "$target_wid" ]]; then
        local title_var="PERSONA_${ACTIVE_PERSONA}_TITLE"
        local target_title="${!title_var:-}"
        target_wid=$(find_window_id "$target_title")
        [[ -z "$target_wid" ]] && die "Cannot find window for ${ACTIVE_PERSONA}"
    fi

    # Start a new segment
    local segment_count
    segment_count=$(ls "${OUTPUT_DIR}"/*.mov 2>/dev/null | wc -l | tr -d ' ')
    local recording_file="${OUTPUT_DIR}/segment-${segment_count}-${ACTIVE_PERSONA}.mov"

    echo "Resuming recording of ${ACTIVE_PERSONA} (WID ${target_wid})..."
    screencapture -v -C -k -x "-l${target_wid}" "$recording_file" &
    local sc_pid=$!
    echo "$sc_pid" > "${state_dir}/screencapture.pid"

    # Mark as not paused
    _config_set "${state_dir}/config" "PAUSED" "false"

    sleep 0.5
    echo "Recording resumed for ${ACTIVE_PERSONA} (PID ${sc_pid})"
}

cmd_position() {
    local state_dir="${RECORDING_STATE_DIR:-}"
    if [[ -z "$state_dir" ]]; then
        if [[ -n "${RECORDING_OUTPUT_DIR:-}" ]]; then
            state_dir=$(get_state_dir "$RECORDING_OUTPUT_DIR")
        else
            die "Set RECORDING_OUTPUT_DIR or RECORDING_STATE_DIR"
        fi
    fi

    if [[ -f "${state_dir}/config" ]]; then
        source "${state_dir}/config"
        echo "Viewport: ${VP_WIDTH}x${VP_HEIGHT}"
        echo "Personas: ${PERSONAS}"
        for p in ${PERSONAS}; do
            local wid_var="PERSONA_${p}_WID"
            echo "  ${p} WID: ${!wid_var:-not found}"
        done
        echo "Active persona: ${ACTIVE_PERSONA}"
    fi
}

# Concatenate all recording segments into per-persona videos.
# Usage: record-window.sh split <output-dir> <action-log.jsonl>
cmd_split() {
    local output_dir="${2:-}"
    local action_log="${3:-}"

    [[ -z "$output_dir" || -z "$action_log" ]] && \
        die "Usage: record-window.sh split <output-dir> <action-log.jsonl>"

    [[ -f "$action_log" ]] || die "Action log not found: ${action_log}"

    echo "Processing recording segments..."

    # Check what recording files we have
    local mov_files
    mov_files=$(ls "${output_dir}"/*.mov 2>/dev/null || true)
    if [[ -z "$mov_files" ]]; then
        die "No recording files (.mov) found in ${output_dir}"
    fi

    echo "Found recordings:"
    ls -la "${output_dir}"/*.mov

    # If there's a single raw-recording.mov, we need to split by timestamps.
    # If there are per-persona segment files, we just need to concatenate per persona.
    if [[ -f "${output_dir}/raw-recording.mov" ]] && ! ls "${output_dir}"/segment-*.mov &>/dev/null; then
        # Single recording — split by JSONL timestamps
        echo "Single recording mode — splitting by timestamps..."
        _split_by_timestamps "$output_dir" "$action_log" "${output_dir}/raw-recording.mov"
    else
        # Multiple segment files — concatenate per persona
        echo "Segment mode — concatenating per persona..."
        _concat_segments "$output_dir"
    fi
}

_split_by_timestamps() {
    local output_dir="$1"
    local action_log="$2"
    local raw_video="$3"

    python3 - "$raw_video" "$action_log" "$output_dir" <<'PYEOF'
import json
import subprocess
import sys
import os

raw_video = sys.argv[1]
action_log_path = sys.argv[2]
output_dir = sys.argv[3]

entries = []
with open(action_log_path) as f:
    for line in f:
        line = line.strip()
        if line:
            entries.append(json.loads(line))

if not entries:
    print("ERROR: Empty action log", file=sys.stderr)
    sys.exit(1)

try:
    result = subprocess.run(
        ["ffprobe", "-v", "quiet", "-show_entries", "format=duration",
         "-of", "csv=p=0", raw_video],
        capture_output=True, text=True
    )
    total_duration_sec = float(result.stdout.strip())
except (ValueError, subprocess.CalledProcessError):
    total_duration_sec = entries[-1]["timestampMs"] / 1000.0 + 2.0

total_duration_ms = total_duration_sec * 1000

segments = []
current_persona = None
current_start_ms = 0

for entry in entries:
    persona = entry.get("persona")
    action = entry.get("action", "")
    ts = entry.get("timestampMs", 0)

    if action in ("scene", "persona-switch") and persona:
        if current_persona and current_persona != persona:
            segments.append({
                "persona": current_persona,
                "startMs": current_start_ms,
                "endMs": ts
            })
            current_start_ms = ts
        if current_persona is None:
            current_start_ms = ts
        current_persona = persona

if current_persona:
    segments.append({
        "persona": current_persona,
        "startMs": current_start_ms,
        "endMs": total_duration_ms
    })

all_personas = set()
for seg in segments:
    p = seg.get("persona")
    if p:
        all_personas.add(p)
persona_segments = {p: [] for p in all_personas}
for seg in segments:
    p = seg["persona"]
    if p in persona_segments:
        persona_segments[p].append(seg)

for persona, segs in persona_segments.items():
    if not segs:
        print(f"No segments for {persona}, creating placeholder")
        out = os.path.join(output_dir, f"{persona}-recording.mp4")
        subprocess.run([
            "ffmpeg", "-y", "-f", "lavfi",
            "-i", "color=c=black:s=1920x1080:d=1",
            "-c:v", "libx264", "-preset", "fast", "-crf", "23",
            "-pix_fmt", "yuv420p", out
        ], capture_output=True)
        continue

    if len(segs) == 1:
        seg = segs[0]
        start_sec = seg["startMs"] / 1000.0
        duration_sec = (seg["endMs"] - seg["startMs"]) / 1000.0
        out = os.path.join(output_dir, f"{persona}-recording.mp4")
        cmd = [
            "ffmpeg", "-y",
            "-ss", f"{start_sec:.3f}",
            "-t", f"{duration_sec:.3f}",
            "-i", raw_video,
            "-c:v", "libx264", "-preset", "fast", "-crf", "23",
            "-pix_fmt", "yuv420p", "-an", out
        ]
        print(f"  {persona}: {start_sec:.1f}s - {start_sec + duration_sec:.1f}s")
        subprocess.run(cmd, capture_output=True)
    else:
        concat_file = os.path.join(output_dir, f".concat-{persona}.txt")
        segment_files = []

        for i, seg in enumerate(segs):
            start_sec = seg["startMs"] / 1000.0
            duration_sec = (seg["endMs"] - seg["startMs"]) / 1000.0
            seg_file = os.path.join(output_dir, f".{persona}-seg-{i}.mp4")
            segment_files.append(seg_file)

            cmd = [
                "ffmpeg", "-y",
                "-ss", f"{start_sec:.3f}",
                "-t", f"{duration_sec:.3f}",
                "-i", raw_video,
                "-c:v", "libx264", "-preset", "fast", "-crf", "23",
                "-pix_fmt", "yuv420p", "-an", seg_file
            ]
            print(f"  {persona} segment {i}: {start_sec:.1f}s - {start_sec + duration_sec:.1f}s")
            subprocess.run(cmd, capture_output=True)

        with open(concat_file, "w") as f:
            for sf in segment_files:
                f.write(f"file '{os.path.abspath(sf)}'\n")

        out = os.path.join(output_dir, f"{persona}-recording.mp4")
        subprocess.run([
            "ffmpeg", "-y",
            "-f", "concat", "-safe", "0",
            "-i", concat_file,
            "-c:v", "libx264", "-preset", "fast", "-crf", "23",
            "-pix_fmt", "yuv420p", "-an", out
        ], capture_output=True)

        os.unlink(concat_file)
        for sf in segment_files:
            try:
                os.unlink(sf)
            except OSError:
                pass

    print(f"  -> {os.path.join(output_dir, f'{persona}-recording.mp4')}")

print("Split complete")
PYEOF
}

_concat_segments() {
    local output_dir="$1"

    # Discover personas from segment file names + initial recording config
    local personas
    personas=$(ls "${output_dir}"/segment-*-*.mov 2>/dev/null \
        | sed 's/.*segment-[0-9]*-//' | sed 's/\.mov//' | sort -u)

    # Include the initial recording persona (read from config, default to admin)
    local initial_persona="admin"
    local target_w="" target_h=""
    local state_dir
    state_dir=$(get_state_dir "$output_dir")
    if [[ -f "${state_dir}/config" ]]; then
        source "${state_dir}/config"
        # First persona in PERSONAS list is the initial one
        initial_persona="${PERSONAS%% *}"
        # Use configured viewport as target (at 2x retina)
        if [[ -n "${VP_WIDTH:-}" && -n "${VP_HEIGHT:-}" ]]; then
            target_w=$((VP_WIDTH * 2))
            target_h=$((VP_HEIGHT * 2))
        fi
    fi
    if [[ -f "${output_dir}/raw-recording.mov" ]]; then
        personas=$(echo -e "${initial_persona}\n${personas}" | sort -u)
    fi

    for persona in $personas; do
        local all_segments=""

        # For the initial persona: prepend raw-recording.mov if it exists
        # (the recording before the first persona switch)
        if [[ "$persona" == "$initial_persona" && -f "${output_dir}/raw-recording.mov" ]]; then
            all_segments="${output_dir}/raw-recording.mov"
        fi

        local persona_segments
        persona_segments=$(ls "${output_dir}"/segment-*-${persona}.mov 2>/dev/null || true)

        if [[ -n "$persona_segments" ]]; then
            if [[ -n "$all_segments" ]]; then
                all_segments="${all_segments}"$'\n'"${persona_segments}"
            else
                all_segments="$persona_segments"
            fi
        fi

        if [[ -z "$all_segments" ]]; then
            echo "No segments for ${persona}, creating placeholder"
            ffmpeg -y -f lavfi -i "color=c=black:s=1920x1080:d=1" \
                -c:v libx264 -preset fast -crf 23 -pix_fmt yuv420p \
                "${output_dir}/${persona}-recording.mp4" 2>/dev/null
            continue
        fi

        # Determine target resolution: use viewport config or smallest segment
        local norm_w="$target_w" norm_h="$target_h"
        if [[ -z "$norm_w" ]]; then
            # Find the smallest dimensions across segments for safe scaling
            while IFS= read -r sf; do
                local dims
                dims=$(ffprobe -v quiet -show_entries stream=width,height -of csv=p=0 "$sf" | head -1)
                local sw="${dims%%,*}" sh="${dims##*,}"
                if [[ -z "$norm_w" ]] || [[ "$sw" -lt "$norm_w" ]]; then
                    norm_w="$sw"
                    norm_h="$sh"
                fi
            done <<< "$all_segments"
        fi
        # Ensure dimensions are even (required by libx264)
        norm_w=$(( norm_w / 2 * 2 ))
        norm_h=$(( norm_h / 2 * 2 ))

        echo "  ${persona}: normalizing to ${norm_w}x${norm_h}"

        local seg_count
        seg_count=$(echo "$all_segments" | wc -l | tr -d ' ')

        # Video filter: scale to target, then crop to target (handles slight oversize)
        local vf="scale=${norm_w}:${norm_h}:force_original_aspect_ratio=decrease,pad=${norm_w}:${norm_h}:(ow-iw)/2:(oh-ih)/2,setsar=1"

        if [[ "$seg_count" -eq 1 ]]; then
            # Single segment — just convert to mp4
            local seg_file
            seg_file=$(echo "$all_segments" | head -1)
            echo "  ${persona}: converting ${seg_file}"
            ffmpeg -y -i "$seg_file" \
                -vf "$vf" \
                -c:v libx264 -preset fast -crf 23 -pix_fmt yuv420p -an \
                "${output_dir}/${persona}-recording.mp4" 2>/dev/null
        else
            # Multiple segments — normalize each, then concat
            local concat_file="${output_dir}/.concat-${persona}.txt"
            > "$concat_file"
            local seg_idx=0
            while IFS= read -r sf; do
                local mp4="${output_dir}/.norm-${persona}-${seg_idx}.mp4"
                ffmpeg -y -i "$sf" \
                    -vf "$vf" \
                    -c:v libx264 -preset fast -crf 23 -pix_fmt yuv420p -an \
                    "$mp4" 2>/dev/null
                echo "file '$(cd "$(dirname "$mp4")" && pwd)/$(basename "$mp4")'" >> "$concat_file"
                seg_idx=$((seg_idx + 1))
            done <<< "$all_segments"

            ffmpeg -y -f concat -safe 0 -i "$concat_file" \
                -c copy \
                "${output_dir}/${persona}-recording.mp4" 2>/dev/null

            # Clean up temp files
            rm -f "$concat_file"
            for i in $(seq 0 $((seg_idx - 1))); do
                rm -f "${output_dir}/.norm-${persona}-${i}.mp4"
            done
        fi

        echo "  -> ${output_dir}/${persona}-recording.mp4"
    done

    echo "Concatenation complete"
}

# Trim dead time (frozen frames) from a video using ffmpeg freezedetect.
# Usage: record-window.sh trim <input.mp4> <output.mp4> [--freeze-threshold N]
cmd_trim() {
    local input="${2:-}"
    local output="${3:-}"
    local freeze_threshold=3

    # Parse optional flags
    shift 3 2>/dev/null || true
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --freeze-threshold) freeze_threshold="$2"; shift 2 ;;
            *) die "Unknown flag: $1" ;;
        esac
    done

    [[ -z "$input" || -z "$output" ]] && \
        die "Usage: record-window.sh trim <input.mp4> <output.mp4> [--freeze-threshold N]"
    [[ -f "$input" ]] || die "Input file not found: ${input}"

    echo "Trimming frozen frames from ${input} (threshold: ${freeze_threshold}s)..."

    python3 - "$input" "$output" "$freeze_threshold" <<'PYEOF'
import json
import os
import re
import subprocess
import sys
import tempfile

input_file = sys.argv[1]
output_file = sys.argv[2]
freeze_threshold = float(sys.argv[3])
keep_duration = 1.0  # Keep 1s of each freeze as a natural pause

# Step 1: Run freezedetect to find frozen sections
result = subprocess.run(
    [
        "ffmpeg", "-i", input_file,
        "-vf", f"freezedetect=n=-60dB:d={freeze_threshold}",
        "-f", "null", "-"
    ],
    capture_output=True, text=True
)

stderr = result.stderr

# Step 2: Parse freeze_start and freeze_end timestamps
freezes = []
freeze_start = None
for line in stderr.split("\n"):
    m = re.search(r"freeze_start:\s*([\d.]+)", line)
    if m:
        freeze_start = float(m.group(1))
    m = re.search(r"freeze_end:\s*([\d.]+)", line)
    if m and freeze_start is not None:
        freeze_end = float(m.group(1))
        freezes.append((freeze_start, freeze_end))
        freeze_start = None

if not freezes:
    print("No frozen sections found — copying input as-is")
    subprocess.run(["cp", input_file, output_file])
    sys.exit(0)

print(f"Found {len(freezes)} frozen section(s):")
for start, end in freezes:
    print(f"  {start:.1f}s - {end:.1f}s ({end - start:.1f}s)")

# Step 3: Get total duration
probe = subprocess.run(
    ["ffprobe", "-v", "quiet", "-show_entries", "format=duration",
     "-of", "csv=p=0", input_file],
    capture_output=True, text=True
)
total_duration = float(probe.stdout.strip())

# Step 4: Build "keep" segments (non-frozen + 1s of each freeze)
segments = []
pos = 0.0

for freeze_start, freeze_end in freezes:
    # Keep everything before this freeze
    if freeze_start > pos:
        segments.append((pos, freeze_start))
    # Keep 1s of the freeze as a natural pause
    segments.append((freeze_start, min(freeze_start + keep_duration, freeze_end)))
    pos = freeze_end

# Keep everything after the last freeze
if pos < total_duration:
    segments.append((pos, total_duration))

# Filter out tiny segments (< 0.1s)
segments = [(s, e) for s, e in segments if e - s >= 0.1]

if not segments:
    print("ERROR: No segments to keep after trimming", file=sys.stderr)
    sys.exit(1)

kept_duration = sum(e - s for s, e in segments)
removed_duration = total_duration - kept_duration
print(f"Keeping {kept_duration:.1f}s of {total_duration:.1f}s (removing {removed_duration:.1f}s)")

# Step 5: Extract each segment and concatenate
tmpdir = tempfile.mkdtemp(prefix="trim-")
concat_file = os.path.join(tmpdir, "concat.txt")
segment_files = []

for i, (start, end) in enumerate(segments):
    seg_file = os.path.join(tmpdir, f"seg-{i:04d}.mp4")
    segment_files.append(seg_file)
    subprocess.run(
        [
            "ffmpeg", "-y",
            "-ss", f"{start:.3f}",
            "-to", f"{end:.3f}",
            "-i", input_file,
            "-c:v", "libx264", "-preset", "fast", "-crf", "23",
            "-pix_fmt", "yuv420p", "-an", seg_file
        ],
        capture_output=True
    )

with open(concat_file, "w") as f:
    for sf in segment_files:
        f.write(f"file '{sf}'\n")

# Step 6: Concatenate with concat demuxer
subprocess.run(
    [
        "ffmpeg", "-y",
        "-f", "concat", "-safe", "0",
        "-i", concat_file,
        "-c:v", "libx264", "-preset", "fast", "-crf", "23",
        "-pix_fmt", "yuv420p", "-an", output_file
    ],
    capture_output=True
)

# Clean up temp files
for sf in segment_files:
    try:
        os.unlink(sf)
    except OSError:
        pass
try:
    os.unlink(concat_file)
    os.rmdir(tmpdir)
except OSError:
    pass

print(f"Trimmed video: {output_file}")
print(f"  Original: {total_duration:.1f}s → Trimmed: {kept_duration:.1f}s (saved {removed_duration:.1f}s)")
PYEOF
}

# Assemble per-persona videos from screenshots (headless mode).
# Usage: record-window.sh assemble <output-dir> <action-log.jsonl>
cmd_assemble() {
    local output_dir="${2:-}"
    local action_log="${3:-}"

    [[ -z "$output_dir" || -z "$action_log" ]] && \
        die "Usage: record-window.sh assemble <output-dir> <action-log.jsonl>"
    [[ -f "$action_log" ]] || die "Action log not found: ${action_log}"

    echo "Assembling videos from screenshots..."

    python3 - "$output_dir" "$action_log" <<'PYEOF'
import json
import os
import subprocess
import sys

output_dir = sys.argv[1]
action_log_path = sys.argv[2]

# Read action log entries
entries = []
with open(action_log_path) as f:
    for line in f:
        line = line.strip()
        if line:
            entries.append(json.loads(line))

if not entries:
    print("ERROR: Empty action log", file=sys.stderr)
    sys.exit(1)

# Filter to screenshot entries with files
screenshots = [e for e in entries if e.get("action") == "screenshot" and e.get("screenshotFile")]

if not screenshots:
    print("ERROR: No screenshots found in action log", file=sys.stderr)
    sys.exit(1)

# Group by persona
personas = {}
for shot in screenshots:
    persona = shot.get("persona", "default")
    if persona not in personas:
        personas[persona] = []
    personas[persona].append(shot)

screenshots_dir = os.path.join(output_dir, "screenshots")

for persona, shots in personas.items():
    print(f"  {persona}: {len(shots)} screenshots")

    # Build concat demuxer file
    concat_path = os.path.join(output_dir, f".concat-{persona}-assemble.txt")
    lines = []

    for i, shot in enumerate(shots):
        file_path = os.path.join(screenshots_dir, shot["screenshotFile"])
        if not os.path.exists(file_path):
            print(f"    WARNING: Missing screenshot: {file_path}")
            continue

        abs_path = os.path.abspath(file_path)

        # Determine duration
        if shot.get("durationMs"):
            duration_sec = shot["durationMs"] / 1000.0
        elif i < len(shots) - 1:
            gap_ms = shots[i + 1]["timestampMs"] - shot["timestampMs"]
            duration_sec = max(0.3, min(5.0, gap_ms / 1000.0))
        else:
            duration_sec = 1.5  # Default for last frame

        lines.append(f"file '{abs_path}'")
        lines.append(f"duration {duration_sec:.3f}")

    if not lines:
        print(f"    No valid screenshots for {persona}, skipping")
        continue

    # Repeat last file (ffmpeg concat demuxer requirement)
    last_file_line = [l for l in lines if l.startswith("file ")][-1]
    lines.append(last_file_line)

    with open(concat_path, "w") as f:
        f.write("\n".join(lines))

    output_file = os.path.join(output_dir, f"{persona}-assembled.mp4")

    cmd = [
        "ffmpeg", "-y",
        "-f", "concat", "-safe", "0",
        "-i", concat_path,
        "-vf", "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,format=yuv420p",
        "-c:v", "libx264", "-preset", "fast", "-crf", "23",
        "-r", "30", "-an",
        output_file
    ]

    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"    ERROR: ffmpeg failed for {persona}: {result.stderr[:200]}", file=sys.stderr)
        continue

    # Clean up concat file
    try:
        os.unlink(concat_path)
    except OSError:
        pass

    print(f"  -> {output_file}")

print("Assembly complete")
PYEOF
}

# Crop browser chrome from a recording.
# Auto-detects Chrome's tab bar + address bar + infobar and removes them.
# Usage: record-window.sh crop <input> <output>
cmd_crop() {
    local input="${2:-}"
    local output="${3:-}"

    [[ -z "$input" || -z "$output" ]] && \
        die "Usage: record-window.sh crop <input.mp4> <output.mp4>"
    [[ -f "$input" ]] || die "Input file not found: ${input}"

    echo "Detecting browser chrome in ${input}..."

    # Get video dimensions
    local dims
    dims=$(ffprobe -v quiet -show_entries stream=width,height -of csv=p=0 "$input" | head -1)
    local vid_w="${dims%%,*}" vid_h="${dims##*,}"

    # Chrome Beta on macOS at 2x retina:
    #   Window title bar: ~56px (28px at 1x)
    #   Tab bar: ~76px (38px at 1x)
    #   Address bar + toolbar: ~64px (32px at 1x)
    #   "Chrome is being controlled" infobar: ~48px (24px at 1x)
    #   Total: ~244px at 2x
    #
    # Without infobar (hidden via CSS): ~196px at 2x
    #
    # We use a heuristic: sample the top of the first frame and detect the
    # chrome/content boundary. Fallback to 244px if detection fails.

    local crop_top
    crop_top=$(python3 - "$input" <<'PYEOF'
import subprocess
import sys

input_file = sys.argv[1]

# Extract a single frame as raw RGB to detect the chrome boundary
result = subprocess.run(
    ["ffmpeg", "-i", input_file, "-vframes", "1", "-f", "rawvideo",
     "-pix_fmt", "rgb24", "-"],
    capture_output=True
)

if result.returncode != 0:
    print(276)
    sys.exit(0)

raw = result.stdout

probe = subprocess.run(
    ["ffprobe", "-v", "quiet", "-show_entries", "stream=width,height",
     "-of", "csv=p=0", input_file],
    capture_output=True, text=True
)
dims = probe.stdout.strip().split(",")
width = int(dims[0])
height = int(dims[1])

# Scan at 70% width to avoid the dark CIAB sidebar (which is also dark gray
# like Chrome's UI). At 70% we're well into the content area.
scan_x = int(width * 0.7)
found_transition = False

for y in range(100, min(500, height)):
    offset = (y * width + scan_x) * 3
    if offset + 3 > len(raw):
        break
    r, g, b = raw[offset], raw[offset+1], raw[offset+2]
    brightness = (r + g + b) / 3

    # Look for sustained light area (> 180 brightness for 20+ consecutive rows)
    if brightness > 180:
        consistent = True
        for check_y in range(y, min(y + 20, height)):
            check_offset = (check_y * width + scan_x) * 3
            if check_offset + 3 > len(raw):
                consistent = False
                break
            cr, cg, cb = raw[check_offset], raw[check_offset+1], raw[check_offset+2]
            if (cr + cg + cb) / 3 < 150:
                consistent = False
                break
        if consistent:
            print(y)
            found_transition = True
            break

if not found_transition:
    print(276)
PYEOF
    )

    # Ensure crop_top is even
    crop_top=$(( (crop_top / 2) * 2 ))

    local crop_h=$(( vid_h - crop_top ))
    # Ensure crop height is even
    crop_h=$(( (crop_h / 2) * 2 ))

    echo "  Video: ${vid_w}x${vid_h}"
    echo "  Chrome height: ${crop_top}px"
    echo "  Cropping to: ${vid_w}x${crop_h} (removing top ${crop_top}px)"

    ffmpeg -y -i "$input" \
        -vf "crop=${vid_w}:${crop_h}:0:${crop_top}" \
        -c:v libx264 -preset fast -crf 23 -pix_fmt yuv420p -an \
        "$output" 2>/dev/null

    echo "  -> ${output}"
}

# Generate a title card (diapo) MP4 clip from a text file.
# Usage: record-window.sh diapo <output-dir> <text-file> [--duration N]
cmd_diapo() {
    local output_dir="${2:-}"
    local text_file="${3:-}"
    local duration=5

    # Parse optional flags
    shift 3 2>/dev/null || true
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --duration) duration="$2"; shift 2 ;;
            *) die "Unknown flag: $1" ;;
        esac
    done

    [[ -z "$output_dir" || -z "$text_file" ]] && \
        die "Usage: record-window.sh diapo <output-dir> <text-file> [--duration N]"
    [[ -f "$text_file" ]] || die "Text file not found: ${text_file}"

    mkdir -p "$output_dir"

    local output_file="${output_dir}/diapo.mp4"

    echo "Generating title card from ${text_file} (${duration}s)..."

    python3 - "$text_file" "$output_file" "$duration" "$output_dir" <<'PYEOF'
import os
import subprocess
import sys
import textwrap

text_file = sys.argv[1]
output_file = sys.argv[2]
duration = int(sys.argv[3])
tmp_dir = sys.argv[4]

with open(text_file) as f:
    raw_text = f.read().strip()

header = "UX Simulator"

# Wrap body text to ~55 chars per line for readability at fontsize 28
wrapped_lines = []
for line in raw_text.split("\n"):
    if len(line) > 60:
        wrapped_lines.extend(textwrap.wrap(line, width=55))
    else:
        wrapped_lines.append(line)
body_text = "\n".join(wrapped_lines)

# Escape special characters for ffmpeg drawtext (inline text)
def escape_drawtext(text):
    return (text
        .replace("\\", "\\\\\\\\")
        .replace("'", "\u2019")
        .replace(":", "\\:")
        .replace("%", "%%"))

escaped_header = escape_drawtext(header)

# Write body to temp file (ffmpeg textfile= handles newlines properly)
body_file = os.path.join(tmp_dir, ".diapo-body.txt")
with open(body_file, "w") as f:
    f.write(body_text)

# Escape the body file path for ffmpeg
body_path_escaped = body_file.replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")

bg_color = "0x1a1a2e"
w, h = 1920, 1080

cmd = [
    "ffmpeg", "-y",
    "-f", "lavfi",
    "-i", f"color=c={bg_color}:s={w}x{h}:d={duration}:r=30",
    "-vf", (
        f"drawtext=text='{escaped_header}'"
        f":fontsize=64:fontcolor=white:font=Helvetica"
        f":x=(w-text_w)/2:y=120"
        f",drawtext=textfile='{body_path_escaped}'"
        f":fontsize=28:fontcolor=0xcccccc:font=Courier"
        f":x=200:y=280"
        f":line_spacing=14"
    ),
    "-c:v", "libx264", "-preset", "fast", "-crf", "23",
    "-pix_fmt", "yuv420p", "-an",
    output_file
]

result = subprocess.run(cmd, capture_output=True, text=True)

# Clean up temp file
try:
    os.unlink(body_file)
except OSError:
    pass

if result.returncode != 0:
    print(f"ERROR: ffmpeg failed: {result.stderr[:500]}", file=sys.stderr)
    sys.exit(1)

print(f"Title card: {output_file} ({duration}s)")
PYEOF

    echo "  -> ${output_file}"
}

# Generate TTS audio for a narration line.
# Returns the duration in seconds. Saves the audio segment to the output dir.
#
# Usage: record-window.sh narrate <output-dir> <text> [--voice <voice>]
#
# The caller uses this in the narrate-then-act loop:
#   1. (recording is paused)
#   2. narrate → generates TTS, prints DURATION_SEC=N.NNN
#   3. resume recording
#   4. sleep for DURATION_SEC (viewer sees the state being narrated)
#   5. perform the browser action (viewer sees the transition)
#   6. pause recording
#   7. goto 1
cmd_narrate() {
    local output_dir="${2:-}"
    local text="${3:-}"
    local voice="Samantha"

    # Parse optional flags
    shift 3 2>/dev/null || true
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --voice) voice="$2"; shift 2 ;;
            *) die "Unknown flag: $1" ;;
        esac
    done

    [[ -z "$output_dir" || -z "$text" ]] && \
        die "Usage: record-window.sh narrate <output-dir> <text> [--voice <voice>]"

    mkdir -p "${output_dir}/audio"

    # Determine segment index
    local seg_count
    seg_count=$(find "${output_dir}/audio" -name 'narr-*.aiff' 2>/dev/null | wc -l | tr -d ' ')

    local aiff_path="${output_dir}/audio/narr-${seg_count}.aiff"

    say -v "$voice" -o "$aiff_path" "$text"

    local duration
    duration=$(ffprobe -v quiet -show_entries format=duration -of csv=p=0 "$aiff_path" 2>/dev/null)

    echo "NARRATION_FILE=${aiff_path}"
    echo "NARRATION_INDEX=${seg_count}"
    echo "DURATION_SEC=${duration}"
}

# Combine all narration audio segments into a single track, then mux with video.
#
# Usage: record-window.sh mux <output-dir> <video.mp4> <output.mp4>
#
# Concatenates all narr-*.aiff files from <output-dir>/audio/ in order,
# converts to AAC, and muxes with the video. Video and audio durations
# are matched by the narrate-then-act loop — this just joins them.
cmd_mux() {
    local output_dir="${2:-}"
    local video="${3:-}"
    local output="${4:-}"

    [[ -z "$output_dir" || -z "$video" || -z "$output" ]] && \
        die "Usage: record-window.sh mux <output-dir> <video.mp4> <output.mp4>"
    [[ -f "$video" ]] || die "Video file not found: ${video}"

    local audio_dir="${output_dir}/audio"
    local segments
    segments=$(ls "${audio_dir}"/narr-*.aiff 2>/dev/null | sort)

    if [[ -z "$segments" ]]; then
        echo "No narration segments found — copying video as-is"
        cp "$video" "$output"
        echo "  -> ${output}"
        return 0
    fi

    local seg_count
    seg_count=$(echo "$segments" | wc -l | tr -d ' ')
    echo "Muxing ${seg_count} narration segments with video..."

    local narration_m4a="${audio_dir}/narration.m4a"

    if [[ "$seg_count" -eq 1 ]]; then
        local single_file
        single_file=$(echo "$segments" | head -1)
        ffmpeg -y -i "$single_file" -c:a aac -b:a 128k "$narration_m4a" 2>/dev/null
    else
        # Build ffmpeg concat command
        local inputs="" filter_inputs="" idx=0
        while IFS= read -r seg_file; do
            inputs="${inputs} -i ${seg_file}"
            filter_inputs="${filter_inputs}[${idx}:a]"
            idx=$((idx + 1))
        done <<< "$segments"

        local filter="${filter_inputs}concat=n=${idx}:v=0:a=1[out]"
        ffmpeg -y ${inputs} -filter_complex "$filter" -map "[out]" \
            -c:a aac -b:a 128k "$narration_m4a" 2>/dev/null
    fi

    local audio_dur video_dur
    audio_dur=$(ffprobe -v quiet -show_entries format=duration -of csv=p=0 "$narration_m4a")
    video_dur=$(ffprobe -v quiet -show_entries format=duration -of csv=p=0 "$video")
    echo "  Audio: ${audio_dur}s, Video: ${video_dur}s"

    # Mux video + audio. Use -shortest to handle minor drift.
    ffmpeg -y -i "$video" -i "$narration_m4a" \
        -c:v copy -c:a aac -b:a 128k -shortest \
        "$output" 2>/dev/null

    echo "  -> ${output}"
}

# ============================================================================
# Session-based commands — Screenshot-first recording (v2)
#
# These replace the screencapture start/stop dance with a deterministic,
# verified screenshot capture workflow:
#
#   session-start <output-dir> --personas admin,buyer,recipient
#   session-capture <output-dir> <persona> <file.png>
#   session-narrate <output-dir> <text> [--voice <voice>]
#   session-scene <output-dir> <name> [--layout <layout>] [--speaker <persona>] [--narration <text>]
#   session-end <output-dir> [--skip-mux]
#
# The agent drives the loop: take_screenshot → session-capture → browser action → repeat
# ============================================================================

cmd_session_start() {
    local output_dir="${2:-}"
    local personas_csv=""

    shift 2 2>/dev/null || true
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --personas) personas_csv="$2"; shift 2 ;;
            *) die "Unknown flag: $1" ;;
        esac
    done

    [[ -z "$output_dir" ]] && \
        die "Usage: record-window.sh session-start <output-dir> --personas admin,buyer,recipient"

    mkdir -p "$output_dir"

    # Create screenshot directories for each persona
    IFS=',' read -ra persona_arr <<< "${personas_csv:-default}"
    for p in "${persona_arr[@]}"; do
        mkdir -p "${output_dir}/screenshots/${p}"
    done

    # Initialize empty action log
    : > "${output_dir}/action-log.jsonl"

    # Write session state
    local state_file="${output_dir}/.session-state.json"
    local personas_json="["
    local first=true
    for p in "${persona_arr[@]}"; do
        $first || personas_json+=","
        personas_json+="\"${p}\""
        first=false
    done
    personas_json+="]"

    local start_ms
    start_ms=$(_epoch_ms)

    cat > "$state_file" <<STATEOF
{
    "startTime": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
    "startEpochMs": ${start_ms},
    "outputDir": "${output_dir}",
    "personas": ${personas_json},
    "status": "recording"
}
STATEOF

    # Initialize per-persona frame counters (O(1) lookups instead of grep -c)
    for p in "${persona_arr[@]}"; do
        echo "0" > "${output_dir}/.frame-count-${p}"
    done

    # Preflight checks
    local checks_passed=true
    echo "Session preflight:"

    if command -v ffmpeg &>/dev/null; then
        echo "  [OK] ffmpeg"
    else
        echo "  [FAIL] ffmpeg not found — install with: brew install ffmpeg"
        checks_passed=false
    fi

    if command -v say &>/dev/null; then
        echo "  [OK] say (macOS TTS)"
    else
        echo "  [FAIL] say not found — macOS required"
        checks_passed=false
    fi

    if [[ -w "$output_dir" ]]; then
        echo "  [OK] output dir writable"
    else
        echo "  [FAIL] output dir not writable: ${output_dir}"
        checks_passed=false
    fi

    local disk_avail
    disk_avail=$(df -k "$output_dir" | awk 'NR==2 {print int($4/1024)}')
    if [[ "$disk_avail" -gt 500 ]]; then
        echo "  [OK] disk space: ${disk_avail}MB available"
    else
        echo "  [WARN] low disk space: ${disk_avail}MB"
    fi

    if $checks_passed; then
        echo ""
        echo "Session started: ${output_dir}"
        echo "Personas: ${personas_csv:-default}"
        echo "Action log: ${output_dir}/action-log.jsonl"
    else
        echo ""
        echo "WARNING: Some preflight checks failed"
    fi
}

# Verify and log a screenshot capture.
# The agent has already taken the screenshot via MCP — this just verifies and logs it.
cmd_session_capture() {
    local output_dir="${2:-}"
    local persona="${3:-}"
    local file_path="${4:-}"
    local duration_ms=""

    shift 4 2>/dev/null || true
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --duration) duration_ms="$2"; shift 2 ;;
            *) die "Unknown flag: $1" ;;
        esac
    done

    [[ -z "$output_dir" || -z "$persona" || -z "$file_path" ]] && \
        die "Usage: record-window.sh session-capture <output-dir> <persona> <file.png> [--duration <ms>]"

    local state_file="${output_dir}/.session-state.json"
    [[ -f "$state_file" ]] || die "No active session in ${output_dir}. Run session-start first."

    # Verify the screenshot file
    if [[ ! -f "$file_path" ]]; then
        echo "VERIFIED=false"
        echo "ERROR=file_not_found"
        return 1
    fi

    local file_size
    file_size=$(wc -c < "$file_path" | tr -d ' ')
    if [[ "$file_size" -lt 1024 ]]; then
        echo "VERIFIED=false"
        echo "ERROR=file_too_small"
        echo "SIZE=${file_size}"
        return 1
    fi

    # Compute timestamp relative to session start
    local start_epoch_ms
    start_epoch_ms=$(_json_read "$state_file" startEpochMs)
    local now_ms
    now_ms=$(_epoch_ms)
    local timestamp_ms=$(( now_ms - start_epoch_ms ))

    # Read frame counter (O(1) — no grep scan)
    local counter_file="${output_dir}/.frame-count-${persona}"
    local frame_count=0
    [[ -f "$counter_file" ]] && frame_count=$(cat "$counter_file")

    # Compute relative path from screenshots dir
    local screenshots_dir="${output_dir}/screenshots"
    local rel_path="${file_path#${screenshots_dir}/}"

    # Auto-use pending narration duration if no explicit --duration given.
    # The pending file is written by session-narrate and consumed here (once).
    if [[ -z "$duration_ms" ]]; then
        local pending_file="${output_dir}/.pending-narration-duration"
        if [[ -f "$pending_file" ]]; then
            duration_ms=$(cat "$pending_file")
            rm -f "$pending_file"
        fi
    fi

    # Build action log entry — JSON-escape variable values
    local persona_json rel_json duration_field=""
    persona_json=$(_json_escape "$persona")
    rel_json=$(_json_escape "$rel_path")
    [[ -n "$duration_ms" ]] && duration_field=", \"durationMs\": ${duration_ms}"

    echo "{\"frame\": ${frame_count}, \"timestampMs\": ${timestamp_ms}, \"persona\": ${persona_json}, \"action\": \"screenshot\", \"screenshotFile\": ${rel_json}${duration_field}}" \
        >> "${output_dir}/action-log.jsonl"

    # Increment frame counter
    echo "$(( frame_count + 1 ))" > "$counter_file"

    echo "VERIFIED=true"
    echo "FRAME=${frame_count}"
    echo "TIMESTAMP_MS=${timestamp_ms}"
    echo "FILE=${file_path}"
    echo "SIZE=${file_size}"
}

# Generate TTS narration for a session.
# Wrapper around existing cmd_narrate, but also logs to the session action log.
cmd_session_narrate() {
    local output_dir="${2:-}"
    local text="${3:-}"
    local voice="Samantha"
    local persona=""

    shift 3 2>/dev/null || true
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --voice) voice="$2"; shift 2 ;;
            --persona) persona="$2"; shift 2 ;;
            *) die "Unknown flag: $1" ;;
        esac
    done

    [[ -z "$output_dir" || -z "$text" ]] && \
        die "Usage: record-window.sh session-narrate <output-dir> <text> [--voice <voice>] [--persona <name>]"

    local state_file="${output_dir}/.session-state.json"
    [[ -f "$state_file" ]] || die "No active session in ${output_dir}. Run session-start first."

    mkdir -p "${output_dir}/audio"

    local seg_count
    seg_count=$(find "${output_dir}/audio" -name 'narr-*.aiff' 2>/dev/null | wc -l | tr -d ' ')

    local aiff_path="${output_dir}/audio/narr-${seg_count}.aiff"

    say -v "$voice" -o "$aiff_path" "$text"

    local duration
    duration=$(ffprobe -v quiet -show_entries format=duration -of csv=p=0 "$aiff_path" 2>/dev/null)

    local duration_ms
    duration_ms=$(awk "BEGIN {printf \"%d\", ${duration} * 1000}")

    # Resolve persona — use first persona from session if not specified
    [[ -z "$persona" ]] && \
        persona=$(_session_first_persona "$state_file")

    # Compute timestamp relative to session start
    local start_epoch_ms
    start_epoch_ms=$(_json_read "$state_file" startEpochMs)
    local now_ms
    now_ms=$(_epoch_ms)
    local timestamp_ms=$(( now_ms - start_epoch_ms ))

    # JSON-escape variable values
    local text_json persona_json audio_json
    text_json=$(_json_escape "$text")
    persona_json=$(_json_escape "$persona")
    audio_json=$(_json_escape "audio/narr-${seg_count}.aiff")

    # Log narration entry to action log
    echo "{\"frame\": ${seg_count}, \"timestampMs\": ${timestamp_ms}, \"persona\": ${persona_json}, \"action\": \"narration\", \"narration\": ${text_json}, \"audioFile\": ${audio_json}, \"durationMs\": ${duration_ms}}" \
        >> "${output_dir}/action-log.jsonl"

    # Write pending narration duration — next session-capture will auto-use it
    echo "$duration_ms" > "${output_dir}/.pending-narration-duration"

    echo "NARRATION_FILE=${aiff_path}"
    echo "NARRATION_INDEX=${seg_count}"
    echo "DURATION_SEC=${duration}"
    echo "DURATION_MS=${duration_ms}"
}

# Mark a scene boundary in the session action log.
cmd_session_scene() {
    local output_dir="${2:-}"
    local scene_name="${3:-}"
    local layout="full"
    local speaker=""
    local narration=""
    local hold_ms=""

    shift 3 2>/dev/null || true
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --layout) layout="$2"; shift 2 ;;
            --speaker) speaker="$2"; shift 2 ;;
            --narration) narration="$2"; shift 2 ;;
            --hold) hold_ms="$2"; shift 2 ;;
            *) die "Unknown flag: $1" ;;
        esac
    done

    [[ -z "$output_dir" || -z "$scene_name" ]] && \
        die "Usage: record-window.sh session-scene <output-dir> <name> [--layout <layout>] [--speaker <persona>] [--narration <text>] [--hold <ms>]"

    local state_file="${output_dir}/.session-state.json"
    [[ -f "$state_file" ]] || die "No active session in ${output_dir}. Run session-start first."

    # Get session start time
    local start_epoch_ms
    start_epoch_ms=$(_json_read "$state_file" startEpochMs)
    local now_ms
    now_ms=$(_epoch_ms)
    local timestamp_ms=$(( now_ms - start_epoch_ms ))

    # Use first persona as default speaker
    [[ -z "$speaker" ]] && \
        speaker=$(_session_first_persona "$state_file")

    # Read frame counter (O(1))
    local counter_file="${output_dir}/.frame-count-${speaker}"
    local frame_count=0
    [[ -f "$counter_file" ]] && frame_count=$(cat "$counter_file")

    # JSON-escape variable values
    local speaker_json scene_json layout_json
    speaker_json=$(_json_escape "$speaker")
    scene_json=$(_json_escape "$scene_name")
    layout_json=$(_json_escape "$layout")

    # Build optional fields
    local narration_field=""
    [[ -n "$narration" ]] && narration_field=", \"narration\": $(_json_escape "$narration")"

    local hold_field=""
    [[ -n "$hold_ms" ]] && hold_field=", \"holdMs\": ${hold_ms}"

    echo "{\"frame\": ${frame_count}, \"timestampMs\": ${timestamp_ms}, \"persona\": ${speaker_json}, \"action\": \"scene\", \"target\": ${scene_json}, \"layout\": ${layout_json}${narration_field}${hold_field}}" \
        >> "${output_dir}/action-log.jsonl"

    echo "Scene '${scene_name}' logged (layout: ${layout}, speaker: ${speaker})"
}

# End a recording session — assemble screenshots into video and mux with narration.
cmd_session_end() {
    local output_dir="${2:-}"
    local skip_mux=false

    shift 2 2>/dev/null || true
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --skip-mux) skip_mux=true; shift ;;
            *) die "Unknown flag: $1" ;;
        esac
    done

    [[ -z "$output_dir" ]] && \
        die "Usage: record-window.sh session-end <output-dir> [--skip-mux]"

    local action_log="${output_dir}/action-log.jsonl"
    [[ -f "$action_log" ]] || die "Action log not found: ${action_log}"

    echo "=== Session End ==="
    echo ""

    # Step 1: Report stats
    local total_screenshots
    total_screenshots=$(grep -c '"action": "screenshot"' "$action_log" 2>/dev/null || echo 0)
    local total_scenes
    total_scenes=$(grep -c '"action": "scene"' "$action_log" 2>/dev/null || echo 0)
    local total_narrations
    total_narrations=$(grep -c '"action": "narration"' "$action_log" 2>/dev/null || echo 0)
    echo "Stats: ${total_screenshots} screenshots, ${total_scenes} scenes, ${total_narrations} narrations"

    # Step 2: Assemble screenshots into per-persona videos
    echo ""
    echo "--- Assembling per-persona videos ---"
    cmd_assemble assemble "$output_dir" "$action_log"

    if $skip_mux; then
        echo ""
        echo "Skipping mux (--skip-mux). Per-persona videos ready in ${output_dir}/"
        return 0
    fi

    # Step 3: Find assembled videos
    local assembled_videos=()
    for f in "${output_dir}"/*-assembled.mp4; do
        [[ -f "$f" ]] && assembled_videos+=("$f")
    done

    if [[ ${#assembled_videos[@]} -eq 0 ]]; then
        echo "WARNING: No assembled videos found"
        return 1
    fi

    echo ""
    echo "Assembled videos: ${assembled_videos[*]}"

    # Step 4: If single persona, mux directly. If multiple, note that scene composition is separate.
    if [[ ${#assembled_videos[@]} -eq 1 ]]; then
        local video="${assembled_videos[0]}"
        local final_output="${output_dir}/final.mp4"

        echo ""
        echo "--- Muxing single-persona video with narration ---"
        cmd_mux mux "$output_dir" "$video" "$final_output"

        echo ""
        echo "=== Final video: ${final_output} ==="
    else
        echo ""
        echo "Multiple personas detected. Per-persona videos assembled."
        echo "For multi-persona composition, use the TypeScript SceneComposer:"
        echo "  1. Each persona video: ${output_dir}/<persona>-assembled.mp4"
        echo "  2. Audio: ${output_dir}/audio/"
        echo "  3. Action log: ${action_log}"
        echo ""

        # If there's a simple two-persona case, try muxing the first one as a default
        local first_video="${assembled_videos[0]}"
        local final_output="${output_dir}/final.mp4"
        echo "--- Muxing first persona video as default ---"
        cmd_mux mux "$output_dir" "$first_video" "$final_output"

        echo ""
        echo "=== Default video: ${final_output} ==="
        echo "(For full composition with layouts, use SceneComposer)"
    fi

    # Step 5: Update session state
    local state_file="${output_dir}/.session-state.json"
    if [[ -f "$state_file" ]]; then
        python3 -c "
import json
with open('${state_file}') as f:
    state = json.load(f)
state['status'] = 'completed'
state['endTime'] = '$(date -u +%Y-%m-%dT%H:%M:%SZ)'
with open('${state_file}', 'w') as f:
    json.dump(state, f, indent=4)
"
    fi
}

# Main dispatch
case "$COMMAND" in
    start)    cmd_start "$@" ;;
    switch)   cmd_switch "$@" ;;
    stop)     cmd_stop "$@" ;;
    pause)    cmd_pause "$@" ;;
    resume)   cmd_resume "$@" ;;
    position) cmd_position "$@" ;;
    split)    cmd_split "$@" ;;
    trim)     cmd_trim "$@" ;;
    crop)     cmd_crop "$@" ;;
    assemble) cmd_assemble "$@" ;;
    diapo)    cmd_diapo "$@" ;;
    narrate)  cmd_narrate "$@" ;;
    mux)      cmd_mux "$@" ;;
    session-start)   cmd_session_start "$@" ;;
    session-capture) cmd_session_capture "$@" ;;
    session-narrate) cmd_session_narrate "$@" ;;
    session-scene)   cmd_session_scene "$@" ;;
    session-end)     cmd_session_end "$@" ;;
    *)
        echo "Usage: record-window.sh <command>"
        echo ""
        echo "Screenshot-based recording (v2 — preferred):"
        echo "  session-start <dir> --personas a,b,c  Start session, run preflight"
        echo "  session-capture <dir> <persona> <png> Verify + log a screenshot"
        echo "  session-narrate <dir> <text> [flags]  Generate TTS, print duration"
        echo "  session-scene <dir> <name> [flags]    Mark scene boundary"
        echo "  session-end <dir> [--skip-mux]        Assemble video + mux audio"
        echo ""
        echo "Screen recording (v1 — legacy):"
        echo "  start <output-dir> [--viewport WxH]  Start recording Chrome window"
        echo "  switch <persona>                      Switch to recording another persona's window"
        echo "  stop                                  Stop recording gracefully"
        echo "  pause                                 Pause recording (stop capture, keep state)"
        echo "  resume                                Resume recording after pause"
        echo "  position                              Show current recording state"
        echo ""
        echo "Post-processing:"
        echo "  split <output-dir> <action-log.jsonl> Process recordings into per-persona videos"
        echo "  trim <input> <output> [--freeze-threshold N]  Remove frozen frames from video"
        echo "  crop <input> <output>                 Remove browser chrome from recording"
        echo "  assemble <output-dir> <log.jsonl>     Assemble screenshots into video"
        echo "  diapo <output-dir> <text-file> [--duration N]  Generate title card video clip"
        echo "  narrate <output-dir> <text> [--voice V]    Generate TTS audio, print duration"
        echo "  mux <output-dir> <video> <output>          Combine narration audio with video"
        echo ""
        echo "Environment:"
        echo "  RECORDING_OUTPUT_DIR              Output directory (for switch/stop/position)"
        echo "  <PERSONA>_WINDOW_TITLE            Window title substring for each persona"
        echo "                                    (e.g. ADMIN_WINDOW_TITLE, BUYER_WINDOW_TITLE)"
        exit 1
        ;;
esac
