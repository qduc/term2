import fs from 'node:fs';
/**
 * Append-only JSONL file. One `append` call is one write plus fsync, so a
 * step's facts land together; a torn final line from a crash is ignored on read.
 */
export class JsonlSessionLog {
    #path;
    #lastSeq;
    constructor(path) {
        this.#path = path;
        const { entries, validBytes } = readEntries(path);
        // Drop a torn tail now, so the next append does not land after garbage.
        if (fs.existsSync(path) && fs.statSync(path).size > validBytes)
            fs.truncateSync(path, validBytes);
        this.#lastSeq = entries.at(-1)?.seq ?? 0;
    }
    get lastSeq() {
        return this.#lastSeq;
    }
    async append(facts) {
        const at = new Date().toISOString();
        const entries = facts.map((fact, index) => ({ seq: this.#lastSeq + index + 1, at, fact }));
        const fd = fs.openSync(this.#path, 'a');
        try {
            fs.writeSync(fd, entries.map((entry) => JSON.stringify(entry) + '\n').join(''));
            fs.fsyncSync(fd);
        }
        finally {
            fs.closeSync(fd);
        }
        this.#lastSeq += entries.length;
        return entries.map((entry) => entry.seq);
    }
    async *read(fromSeq = 0) {
        for (const entry of readEntries(this.#path).entries)
            if (entry.seq > fromSeq)
                yield entry;
    }
}
function readEntries(path) {
    if (!fs.existsSync(path))
        return { entries: [], validBytes: 0 };
    const text = fs.readFileSync(path, 'utf8');
    const entries = [];
    let validBytes = 0;
    for (const line of text.split('\n')) {
        const end = validBytes + Buffer.byteLength(line) + 1;
        if (end > Buffer.byteLength(text))
            break; // last line has no newline: torn
        try {
            if (line)
                entries.push(JSON.parse(line));
        }
        catch {
            break; // torn tail from a crash mid-write
        }
        validBytes = end;
    }
    return { entries, validBytes };
}
//# sourceMappingURL=jsonl-log.js.map