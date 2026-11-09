import * as acp from '@agentclientprotocol/sdk';
import { DirectProtocolError } from '../../../protocol/errors.js';

/** Keep v1 operational failures distinct from the reserved authentication error. */
export function v1Error(error: unknown): unknown {
  if (error instanceof acp.RequestError) {
    if (error.code === -32000) return new acp.RequestError(-32010, error.message);
    if (error.code === -32001) return acp.RequestError.resourceNotFound();
  }
  if (error instanceof DirectProtocolError) {
    if (error.code === 'not_found') return acp.RequestError.resourceNotFound();
    if (error.code === 'invalid_command') return acp.RequestError.invalidParams();
  }
  return error;
}
