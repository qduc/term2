export class OpenRouterError extends Error {
  status: number;
  headers: Record<string, string>;
  responseBody?: string;

  constructor(message: string, status: number, headers: Record<string, string>, responseBody?: string) {
    super(message);
    this.name = 'OpenRouterError';
    this.status = status;
    this.headers = headers;
    this.responseBody = responseBody;
  }
}

export class OpenAICompatibleError extends Error {
  status: number;
  headers: Record<string, string>;
  responseBody?: string;

  constructor(message: string, status: number, headers: Record<string, string>, responseBody?: string) {
    super(message);
    this.name = 'OpenAICompatibleError';
    this.status = status;
    this.headers = headers;
    this.responseBody = responseBody;
  }
}
