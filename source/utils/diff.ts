export function generateDiff(oldText: string, newText: string): string {
    // Safely coerce inputs to strings, treating null/undefined as empty strings
    const safeOldText = oldText == null ? '' : String(oldText);
    const safeNewText = newText == null ? '' : String(newText);

    const oldLines = safeOldText.split('\n');
    const newLines = safeNewText.split('\n');
    const N = oldLines.length;
    const M = newLines.length;

    const lcsMatrix = Array(N + 1)
        .fill(0)
        .map(() => Array(M + 1).fill(0));

    for (let i = 1; i <= N; i++) {
        for (let j = 1; j <= M; j++) {
            if (oldLines[i - 1] === newLines[j - 1]) {
                lcsMatrix[i][j] = lcsMatrix[i - 1][j - 1] + 1;
            } else {
                lcsMatrix[i][j] = Math.max(
                    lcsMatrix[i - 1][j],
                    lcsMatrix[i][j - 1],
                );
            }
        }
    }

    let i = N;
    let j = M;
    const diffLines: string[] = [];

    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
            diffLines.unshift(' ' + oldLines[i - 1]);
            i--;
            j--;
        } else if (
            j > 0 &&
            (i === 0 || lcsMatrix[i][j - 1] >= lcsMatrix[i - 1][j])
        ) {
            diffLines.unshift('+' + newLines[j - 1]);
            j--;
        } else if (
            i > 0 &&
            (j === 0 || lcsMatrix[i][j - 1] < lcsMatrix[i - 1][j])
        ) {
            diffLines.unshift('-' + oldLines[i - 1]);
            i--;
        }
    }

    return diffLines.join('\n');
}
