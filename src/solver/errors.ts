export type SolverErrorCode = 'INVALID_MODEL' | 'UNSTABLE';

/** Error raised for invalid input or structures that cannot be solved. */
export class SolverError extends Error {
  readonly code: SolverErrorCode;
  /** Id of the node most closely associated with the problem, if known. */
  readonly nodeId?: string;
  /** Id of the member most closely associated with the problem, if known. */
  readonly memberId?: string;

  constructor(
    code: SolverErrorCode,
    message: string,
    where: { nodeId?: string; memberId?: string } = {},
  ) {
    super(message);
    this.name = 'SolverError';
    this.code = code;
    this.nodeId = where.nodeId;
    this.memberId = where.memberId;
  }
}
