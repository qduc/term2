// Writes enough output that it cannot all sit in a single pipe buffer, so a
// drain that settles too eagerly would visibly truncate it.
process.stdout.write('x'.repeat(100_000));
