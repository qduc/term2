export interface SessionReadAccess {
  allowFolder(sessionId: string, folder: string): void;
  allows(sessionId: string, targetPath: string, baseDir?: string): boolean;
  clear(sessionId: string): void;
}
