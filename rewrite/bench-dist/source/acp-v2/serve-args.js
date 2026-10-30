import { VALID_REASONING_EFFORTS } from '../services/models/reasoning-effort.js';
const VALUE_FLAGS = new Set(['--provider', '--model', '--effort']);
export function parseAcpArgs(argv) {
    const args = {};
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (!token.startsWith('--'))
            return { ok: false, error: `unexpected argument "${token}"` };
        if (!VALUE_FLAGS.has(token))
            return { ok: false, error: `unknown option "${token}"` };
        const value = argv[index + 1];
        if (value === undefined || value === '' || value.startsWith('--')) {
            return { ok: false, error: `${token} requires a value` };
        }
        index += 1;
        if (token === '--provider')
            args.provider = value;
        else if (token === '--model')
            args.model = value;
        else {
            if (!VALID_REASONING_EFFORTS.includes(value)) {
                return { ok: false, error: `--effort must be one of: ${VALID_REASONING_EFFORTS.join(', ')}` };
            }
            args.effort = value;
        }
    }
    return { ok: true, args };
}
//# sourceMappingURL=serve-args.js.map