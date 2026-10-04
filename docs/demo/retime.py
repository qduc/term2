#!/usr/bin/env python3
"""Retime an asciinema v3 cast so ticker-only redraws take no time.

term2 redraws its status area every second (elapsed time, token counters), so a
recording is never idle and agg's --idle-time-limit cannot compress waiting.
Frames are delimited by synchronized-output markers (?2026h ... ?2026l); a frame
whose text equals the previous frame's once digits are removed is a pure ticker
update, so its delay collapses to TICK. Meaningful frames keep their delay,
capped at CAP seconds.

Usage: retime.py in.cast out.cast [CAP] [TICK]
"""
import json
import re
import sys

src, dst = sys.argv[1], sys.argv[2]
CAP = float(sys.argv[3]) if len(sys.argv) > 3 else 1.2
TICK = float(sys.argv[4]) if len(sys.argv) > 4 else 0.0

lines = open(src).read().splitlines()
header, events = lines[0], [json.loads(x) for x in lines[1:]]

out, frame, prev_key = [], [], None


def flush():
    global prev_key
    if not frame:
        return
    text = ''.join(e[2] for e in frame if e[1] == 'o')
    key = re.sub(r'\d+', '#', text)
    pending = sum(e[0] for e in frame)
    delay = TICK if key == prev_key else min(pending, CAP)
    prev_key = key
    for i, e in enumerate(frame):
        out.append([delay if i == 0 else 0.0, e[1], e[2]])
    frame.clear()


for e in events:
    frame.append(e)
    if e[1] == 'o' and '\x1b[?2026l' in e[2]:
        flush()
flush()

with open(dst, 'w') as f:
    f.write(header + '\n')
    for e in out:
        f.write(json.dumps(e, ensure_ascii=False) + '\n')
print(f'{sum(e[0] for e in events):.0f}s -> {sum(e[0] for e in out):.0f}s')
