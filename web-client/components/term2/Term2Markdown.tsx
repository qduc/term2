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
      className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-zinc-500 transition-colors hover:bg-black/[0.06] hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-white/10 dark:hover:text-zinc-100"
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
    <div className="my-4 overflow-hidden rounded-xl border border-black/[0.06] bg-zinc-50 dark:border-white/[0.07] dark:bg-zinc-950/70">
      <div className="flex items-center justify-between py-1 pl-4 pr-1.5">
        <span className="font-mono text-[11.5px] text-zinc-500">{language || 'text'}</span>
        <CopyButton text={code} label="Copy code" />
      </div>
      <pre className="overflow-x-auto px-4 pb-3.5 pt-0.5 text-[13px] leading-[1.6]">
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
      <code
        className={`rounded-md border border-black/[0.06] bg-zinc-100/80 px-[0.35em] py-[0.1em] font-mono text-[0.86em] dark:border-white/[0.08] dark:bg-white/[0.06] ${className ?? ''}`}
      >
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
        className="md-link font-medium text-teal-700 underline decoration-teal-700/30 underline-offset-[3px] hover:decoration-teal-700 dark:text-teal-400 dark:decoration-teal-400/30 dark:hover:decoration-teal-400"
      >
        {children}
      </a>
    );
  },
  table({ children }) {
    return (
      <div className="my-4 overflow-x-auto rounded-xl border border-black/[0.07] dark:border-white/[0.08]">
        <table className="w-full border-collapse text-sm">{children}</table>
      </div>
    );
  },
  th({ children }) {
    return (
      <th className="border-b border-black/[0.07] bg-zinc-50 px-3 py-2 text-left font-medium text-zinc-600 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-zinc-300">
        {children}
      </th>
    );
  },
  td({ children }) {
    return <td className="border-t border-black/[0.05] px-3 py-2 dark:border-white/[0.06]">{children}</td>;
  },
  h1: ({ children }) => <h1 className="md-h1 mb-3 mt-6 text-[1.4rem] font-semibold tracking-tight first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="md-h2 mb-2 mt-6 text-[1.18rem] font-semibold tracking-tight first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="md-h3 mb-1.5 mt-5 text-base font-semibold tracking-tight first:mt-0">{children}</h3>,
  p: ({ children }) => <p className="md-p my-3 first:mt-0 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="my-3 list-disc space-y-1.5 pl-6 marker:text-zinc-400">{children}</ul>,
  ol: ({ children }) => <ol className="my-3 list-decimal space-y-1.5 pl-6 marker:text-zinc-400">{children}</ol>,
  blockquote: ({ children }) => (
    <blockquote className="my-4 border-l-2 border-teal-500/40 pl-4 text-zinc-600 dark:text-zinc-400">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-6 border-black/[0.07] dark:border-white/[0.08]" />,
};

const remarkPlugins = [remarkGfm];

/**
 * Renders agent text as GitHub-flavoured markdown. Raw HTML is not enabled
 * (react-markdown ignores it by default), so model output cannot inject markup.
 * Memoised on the text so earlier turns do not re-parse while the latest streams.
 */
export const Term2Markdown = memo(function Term2Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={`md-content text-[15px] leading-[1.7] text-zinc-800 dark:text-zinc-200 ${className ?? ''}`}>
      <ReactMarkdown remarkPlugins={remarkPlugins} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});

export { CopyButton as Term2CopyButton };
