export function sanitizeHeaders(headers) {
    if (!headers) {
        return undefined;
    }
    const result = {};
    const addHeader = (key, value) => {
        const lowerKey = key.toLowerCase();
        const valStr = String(value);
        if (/authorization|key|cookie|token|secret|signature/i.test(lowerKey)) {
            result[lowerKey] = '[REDACTED]';
        }
        else {
            result[lowerKey] = valStr;
        }
    };
    const rawHeaders = headers;
    if (Array.isArray(rawHeaders)) {
        for (const item of rawHeaders) {
            if (Array.isArray(item) && item.length >= 2) {
                addHeader(String(item[0]), item[1]);
            }
        }
    }
    else if (typeof rawHeaders.forEach === 'function') {
        rawHeaders.forEach((v, k) => {
            addHeader(String(k), v);
        });
    }
    else if (typeof rawHeaders === 'object') {
        for (const [k, v] of Object.entries(rawHeaders)) {
            if (v !== undefined && v !== null) {
                addHeader(k, v);
            }
        }
    }
    return result;
}
//# sourceMappingURL=header-sanitizer.js.map