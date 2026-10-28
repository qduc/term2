'use client';

import { memo, useMemo, useState, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import hljs from 'highlight.js/lib/common';
import { Check, Copy } from 'lucide-react';

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={copied ? 'Copied' : label}
      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-zinc-500 hover:bg-zinc-200 hover:text-zinc-800 dark:hover:bg-zinc-700 dark:hover:text-zinc-100"
      onClick={() => {
        void navigator.clipboard
          ?.writeText(text)
          .then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          })
          .catch(() => undefined);
      }}
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      {copied ? 'Copied' : label}
    </button>
  );
}

function highlight(code: string, language: string | undefined): string | null {
  try {
    if (language && hljs.getLanguage(language)) return hljs.highlight(code, { language, ignoreIllegals: true }).value;
    // Without a fence language, guess only for blocks big enough to be worth it.
    if (code.length > 40) return hljs.highlightAuto(code).value;
  } catch {
    // Fall through to plain text.
  }
  return null;
}

export function Term2CodeBlock({ code, language }: { code: string; language?: string }) {
  const html = useMemo(() => highlight(code, language), [code, language]);
  return (
    <div className="my-3 overflow-hidden rounded-lg border border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex items-center justify-between border-b border-zinc-200 px-3 py-1 dark:border-zinc-800">
        <span className="font-mono text-xs text-zinc-500">{language || 'text'}</span>
        <CopyButton text={code} label="Copy code" />
      </div>
      <pre className="overflow-x-auto p-3 text-[13px] leading-5">
        {html ? (
          <code className="hljs md-code" dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <code className="md-code">{code}</code>
        )}
      </pre>
    </div>
  );
}

const components: Components = {
  // Block code arrives as <pre><code class="language-x">; the pre is replaced
  // wholesale so highlighting and the header live in one component.
  pre({ children }) {
    const child = Array.isArray(children) ? children[0] : children;
    const props = (child as { props?: { className?: string; children?: ReactNode } } | undefined)?.props;
    const language = /language-([\w+-]+)/.exec(props?.className ?? '')?.[1];
    const code = String(props?.children ?? '').replace(/\n$/, '');
    return <Term2CodeBlock code={code} language={language} />;
  },
  code({ className, children }) {
    return (
      <code className={`rounded bg-zinc-100 px-1 py-0.5 font-mono text-[0.85em] dark:bg-zinc-800 ${className ?? ''}`}>
        {children}
      </code>
    );
  },
  a({ href, children }) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="md-link text-teal-700 underline underline-offset-2 dark:text-teal-400"
      >
        {children}
      </a>
    );
  },
  table({ children }) {
    return (
      <div className="my-3 overflow-x-auto">
        <table className="w-full border-collapse text-sm">{children}</table>
      </div>
    );
  },
  th({ children }) {
    return (
      <th className="border-b border-zinc-300 px-3 py-1.5 text-left font-semibold dark:border-zinc-700">{children}</th>
    );
  },
  td({ children }) {
    return <td className="border-b border-zinc-200 px-3 py-1.5 dark:border-zinc-800">{children}</td>;
  },
  h1: ({ children }) => <h1 className="md-h1 mb-2 mt-5 text-xl font-semibold">{children}</h1>,
  h2: ({ children }) => <h2 className="md-h2 mb-2 mt-4 text-lg font-semibold">{children}</h2>,
  h3: ({ children }) => <h3 className="md-h3 mb-1 mt-3 text-base font-semibold">{children}</h3>,
  p: ({ children }) => <p className="md-p my-2 first:mt-0 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-6">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-6">{children}</ol>,
  blockquote: ({ children }) => (
    <blockquote className="my-3 border-l-2 border-zinc-300 pl-3 text-zinc-600 dark:border-zinc-600 dark:text-zinc-400">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-4 border-zinc-200 dark:border-zinc-800" />,
};

const remarkPlugins = [remarkGfm];

/**
 * Renders agent text as GitHub-flavoured markdown. Raw HTML is not enabled
 * (react-markdown ignores it by default), so model output cannot inject markup.
 * Memoised on the text so earlier turns do not re-parse while the latest streams.
 */
export const Term2Markdown = memo(function Term2Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={`md-content text-[15px] leading-7 ${className ?? ''}`}>
      <ReactMarkdown remarkPlugins={remarkPlugins} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});

export { CopyButton as Term2CopyButton };
