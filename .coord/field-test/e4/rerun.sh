#!/bin/bash
# Re-runs the E4 after-cells against the fixed e4-shape build, one at a time.
r=/home/qduc/term2/.coord/field-test/e4
b=/home/qduc/term2/.worktrees/e4-shape
$r/run.sh "$b" after2 ds   deepseek-v4-flash
$r/run.sh "$b" after2 muse muse-spark-1.3-contributor
$r/run.sh "$b" after2 glm  glm-5.3-flash
echo "E4-RERUN-DONE" >> $r/out/summary.tsv
