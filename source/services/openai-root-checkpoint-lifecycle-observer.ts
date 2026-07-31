/** Sanitized, durable evidence for the OpenAI root checkpoint lifecycle. */
export type OpenAIRootCheckpointLifecycleEvidence = {
  type: 'openai_root_checkpoint_lifecycle';
  version: 1;
  stage: 'candidate' | 'publication';
  outcome:
    | 'observed'
    | 'missing_prefix_binding'
    | 'missing_response_id'
    | 'invalid_lineage'
    | 'lineage_rejected'
    | 'promoted'
    | 'history_not_committed'
    | 'candidate_not_promoted';
};

/** Root-owned OpenAI diagnostics only; it retains no provider or request data. */
export interface OpenAIRootCheckpointLifecycleObserver {
  setEvidenceRecorder?(recorder: (evidence: OpenAIRootCheckpointLifecycleEvidence) => void): void;
  candidate(
    outcome: Extract<
      OpenAIRootCheckpointLifecycleEvidence['outcome'],
      'observed' | 'missing_prefix_binding' | 'missing_response_id' | 'invalid_lineage' | 'lineage_rejected'
    >,
  ): void;
  publication(
    outcome: Extract<
      OpenAIRootCheckpointLifecycleEvidence['outcome'],
      'promoted' | 'history_not_committed' | 'candidate_not_promoted'
    >,
  ): void;
}

export class DefaultOpenAIRootCheckpointLifecycleObserver implements OpenAIRootCheckpointLifecycleObserver {
  #recordEvidence: (evidence: OpenAIRootCheckpointLifecycleEvidence) => void = () => {};

  setEvidenceRecorder(recorder: (evidence: OpenAIRootCheckpointLifecycleEvidence) => void): void {
    this.#recordEvidence = recorder;
  }

  candidate(outcome: Parameters<OpenAIRootCheckpointLifecycleObserver['candidate']>[0]): void {
    this.#record('candidate', outcome);
  }

  publication(outcome: Parameters<OpenAIRootCheckpointLifecycleObserver['publication']>[0]): void {
    this.#record('publication', outcome);
  }

  #record(
    stage: OpenAIRootCheckpointLifecycleEvidence['stage'],
    outcome: OpenAIRootCheckpointLifecycleEvidence['outcome'],
  ): void {
    try {
      this.#recordEvidence(Object.freeze({ type: 'openai_root_checkpoint_lifecycle', version: 1, stage, outcome }));
    } catch {
      // Diagnostics must never affect the existing provider or stream path.
    }
  }
}
