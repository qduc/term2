/** Clean v1 transport only: framing, private socket/discovery auth, identity,
 * admission replay and restart pause/drain. This leaf imports no old runtime.
 */
export * from '../../../../source/services/control-socket/control-socket.js';
export { runControlCommand } from '../../../../source/services/control-socket/control-command.js';
