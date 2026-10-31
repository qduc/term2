import React, { useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { MultilineInput } from 'ink-prompt';
import type { WireDecision, WireQuestion } from '../../protocol/direct-wire.js';

/** Collect all typed questions locally and resolve the request once with canonical IDs. */
export function Questions({ questions, width, onBack, onAnswer }: {
  readonly questions: readonly WireQuestion[];
  readonly width: number;
  readonly onBack: () => void;
  readonly onAnswer: (decision: WireDecision) => Promise<void>;
}): React.ReactElement {
  const [index, setIndex] = useState(0);
  const [selected, setSelected] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string | readonly string[]>>({});
  const [entry, setEntry] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const question = questions[index];
  const value = answers[question.id];
  const choices = [
    ...question.options.map(option => option.label),
    ...(question.allowCustom ? ['Something else…'] : []),
    ...(question.multiple ? ['Continue', 'Clear selections'] : []),
    'Decline to answer', 'Stop after resolving',
  ];
  const send = async (decision: WireDecision) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(null);
    try { await onAnswer(decision); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { pending.current = false; setBusy(false); }
  };
  const advance = (next: Record<string, string | readonly string[]>) => {
    setAnswers(next);
    if (index + 1 < questions.length) { setIndex(index + 1); setSelected(0); return; }
    if (questions.some(item => next[item.id] === undefined)) { setError('Answer every question before submitting.'); return; }
    void send({ kind: 'answers', answers: questions.map(item => ({ questionId: item.id, value: next[item.id] })) });
  };
  const choose = (position: number) => {
    if (position < question.options.length) {
      const label = question.options[position].label;
      if (!question.multiple) { advance({ ...answers, [question.id]: label }); return; }
      const previous = Array.isArray(value) ? value : [];
      setAnswers({ ...answers, [question.id]: previous.includes(label) ? previous.filter(item => item !== label) : [...previous, label] });
      return;
    }
    let next = position - question.options.length;
    if (question.allowCustom) { if (next === 0) { setEntry(true); setText(''); return; } next--; }
    if (question.multiple) {
      if (next === 0) {
        if (!Array.isArray(value) || value.length === 0) { setError('Choose at least one answer.'); return; }
        advance(answers); return;
      }
      if (next === 1) { setAnswers({ ...answers, [question.id]: [] }); return; }
      next -= 2;
    }
    if (next === 0) void send({ kind: 'decline' });
    else void send({ kind: 'answer', answer: '', stopAfterApprovalResolution: true });
  };
  useInput((input, key) => {
    if (busy) return;
    if (key.escape) { if (entry) { setEntry(false); setText(''); } else if (index) { setIndex(index - 1); setSelected(0); } else onBack(); return; }
    if (entry) return;
    if (key.upArrow) { setSelected(current => Math.max(0, current - 1)); return; }
    if (key.downArrow) { setSelected(current => Math.min(choices.length - 1, current + 1)); return; }
    if (key.leftArrow && index > 0) { setIndex(index - 1); setSelected(0); return; }
    if (key.rightArrow && index + 1 < questions.length && value !== undefined && (!Array.isArray(value) || value.length)) { setIndex(index + 1); setSelected(0); return; }
    const number = /^[1-9]$/.test(input) ? Number(input) - 1 : -1;
    if (key.return || number >= 0) { const position = number < 0 ? selected : number; if (position < choices.length) choose(position); }
  });
  return <Box flexDirection="column">
    <Text bold>Question {index + 1}/{questions.length}: {question.prompt}</Text>
    {!entry && choices.map((choice, position) => {
      const chosen = question.multiple && Array.isArray(value) && value.includes(choice);
      const description = question.options[position]?.description;
      return <Text key={`${position}:${choice}`}>{selected === position ? '❯' : ' '} {position + 1}. {chosen ? '[x] ' : ''}{choice}{description ? ` — ${description}` : ''}</Text>;
    })}
    {question.multiple && Array.isArray(value) && value.length ? <Text>Selected: {value.join(', ')}</Text> : null}
    {entry ? <MultilineInput value={text} onChange={setText} width={Math.max(1, width - 6)} isActive={!busy}
      ignoreInput={(_input, key) => key.escape}
      onSubmit={input => {
        if (!input.trim()) { setError('Enter an answer.'); return; }
        setEntry(false); setText('');
        if (question.multiple) {
          const previous = Array.isArray(value) ? value : [];
          setAnswers({ ...answers, [question.id]: [...previous, input] });
        } else advance({ ...answers, [question.id]: input });
      }} /> : null}
    {error ? <Text>{error}</Text> : null}
    <Text>↑/↓ select · Enter choose · Esc back</Text>
  </Box>;
}
