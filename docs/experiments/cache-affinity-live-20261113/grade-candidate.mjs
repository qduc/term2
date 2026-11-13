/* global process, console */
// Invoked only in a bounded, credential-scrubbed, network-isolated child.
import { gradeWorkload } from './workloads.mjs';
console.log(JSON.stringify(await gradeWorkload(process.argv[2], process.argv[3])));
