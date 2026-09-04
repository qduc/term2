#!/bin/bash
# 3 repeats per arm of task B on glm, to measure within-arm variance against
# the cm-vs-nocm delta that E5 reported (+69% input tokens).
e5=/home/qduc/term2/.coord/field-test/e5
for i in 1 2 3; do
  $e5/run.sh /home/qduc/term2/.worktrees/e5-nocodemode nocmR$i b glm glm-5.3-flash
  $e5/run.sh /home/qduc/term2/.worktrees/e4-shape      cmR$i   b glm glm-5.3-flash
done
echo "B-REPEATS-DONE" >> $e5/out/summary.tsv
