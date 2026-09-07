/** Balanced paired arm order: each (model, task, trial) is one pair. */

export function buildSchedule({ models, tasks, trials }) {
  if (!Number.isInteger(trials) || trials < 1) {
    throw new Error('trials must be a positive integer');
  }
  const pairs = [];
  let cellIndex = 0;
  models.forEach((model, modelIndex) => {
    tasks.forEach((task, taskIndex) => {
      for (let trial = 0; trial < trials; trial += 1) {
        const candidateFirst = (trial + modelIndex + taskIndex) % 2 === 1;
        const arms = candidateFirst ? ['candidate', 'baseline'] : ['baseline', 'candidate'];
        const pairId = [model.id, task.id, 'trial' + trial].join('__');
        pairs.push({
          pairId,
          model,
          task,
          trial,
          arms,
          cells: arms.map((arm) => ({
            cellId: [pairId, arm].join('__'),
            pairId,
            model,
            task,
            trial,
            arm,
            order: cellIndex++,
          })),
        });
      }
    });
  });
  return {
    pairs,
    cells: pairs.flatMap((pair) => pair.cells),
    totals: {
      models: models.length,
      tasks: tasks.length,
      trials,
      pairs: pairs.length,
      cells: pairs.length * 2,
    },
    armFirstCounts: countArmFirst(pairs),
  };
}

function countArmFirst(pairs) {
  const counts = { baseline: 0, candidate: 0 };
  for (const pair of pairs) {
    counts[pair.arms[0]] += 1;
  }
  return counts;
}
