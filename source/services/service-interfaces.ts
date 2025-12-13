export interface ILoggingService {
    info(message: string, meta?: any): void;
    warn(message: string, meta?: any): void;
    error(message: string, meta?: any): void;
    debug(message: string, meta?: any): void;
    security(message: string, meta?: any): void;
    setCorrelationId(id: string | undefined): void;
    getCorrelationId(): string | undefined;
    clearCorrelationId(): void;
}

export interface ISettingsService {
    get<T = any>(key: string): T;
    set(key: string, value: any): void;
}
