import { LanguageProvider } from './types.js';
import { typescriptProvider, javascriptProvider } from './typescript.js';
import { pythonProvider } from './python.js';
import { goProvider } from './go.js';
import { rustProvider } from './rust.js';
import { jsonProvider } from './json.js';
import { javaProvider } from './java.js';
import { csharpProvider } from './csharp.js';
import { cppProvider } from './cpp.js';
import { rubyProvider } from './ruby.js';
import { phpProvider } from './php.js';

// Re-export all types and utilities
export * from './types.js';
export * from './utils.js';

// Export providers registry
export const providers: LanguageProvider[] = [
  typescriptProvider,
  javascriptProvider,
  pythonProvider,
  goProvider,
  rustProvider,
  jsonProvider,
  javaProvider,
  csharpProvider,
  cppProvider,
  rubyProvider,
  phpProvider,
];

// Helper function to find a provider for a file
export function getProvider(filePath: string): LanguageProvider | null {
  return providers.find((provider) => provider.matches(filePath)) ?? null;
}
