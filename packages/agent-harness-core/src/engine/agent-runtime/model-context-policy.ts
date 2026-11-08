/** Separate model capacity from an optional user cost/latency input ceiling. */
export function resolveModelContextPolicy(input: {
  contextWindow?: number;
  maxOutputTokens?: number;
  inputLimit?: number | null;
  ratio?: number;
  rawTrigger?: number | null;
}) {
  const capacity = input.contextWindow;
  const outputReserve = Math.max(0, Math.ceil(input.maxOutputTokens ?? 0));
  const estimationReserve = capacity === undefined ? 0 : Math.ceil(capacity * 0.1);
  const capacityInput = capacity === undefined ? undefined : Math.max(0, capacity - outputReserve - estimationReserve);
  const hardInputLimit =
    capacityInput === undefined ? input.inputLimit ?? undefined : Math.min(capacityInput, input.inputLimit ?? Infinity);
  const ratioTrigger = capacity === undefined ? undefined : Math.floor(capacity * (input.ratio ?? 0.8));
  const preferred =
    input.rawTrigger == null
      ? ratioTrigger
      : ratioTrigger === undefined
      ? input.rawTrigger
      : Math.min(input.rawTrigger, ratioTrigger);
  const headroomTrigger =
    hardInputLimit === undefined
      ? undefined
      : Math.floor(
          hardInputLimit *
            (input.inputLimit != null && (capacityInput === undefined || input.inputLimit <= capacityInput)
              ? 0.75
              : 0.9),
        );
  const softTrigger =
    preferred === undefined
      ? headroomTrigger
      : headroomTrigger === undefined
      ? preferred
      : Math.min(preferred, headroomTrigger);
  return {
    capacity,
    outputReserve,
    estimationReserve,
    hardInputLimit,
    softTrigger,
    limitSource:
      input.inputLimit != null && (capacityInput === undefined || input.inputLimit <= capacityInput)
        ? ('explicit_input_ceiling' as const)
        : ('model_capacity' as const),
  };
}
