'use client';

/** Render the native parts rather than the text-only protocol summary. */
export function Term2UserContent({ text, content }: { text: string; content?: readonly unknown[] }) {
  if (!content?.length) return <p className="whitespace-pre-wrap break-words text-[15px] leading-6">{text}</p>;

  return (
    <div className="space-y-2">
      {content.map((value, index) => {
        if (!value || typeof value !== 'object') return null;
        const part = value as Record<string, unknown>;
        if (part.type === 'text' && typeof part.text === 'string') {
          return <p key={index} className="whitespace-pre-wrap break-words text-[15px] leading-6">{part.text}</p>;
        }
        if (part.type === 'image' && typeof part.data === 'string' && typeof part.mediaType === 'string' &&
            /^(image\/png|image\/jpeg|image\/gif|image\/webp)$/.test(part.mediaType)) {
          return <img key={index} src={`data:${part.mediaType};base64,${part.data}`} alt="Attached image" className="max-h-80 max-w-full rounded-xl object-contain" />;
        }
        return <p key={index} className="text-sm text-muted-foreground">[Attachment unavailable]</p>;
      })}
    </div>
  );
}
