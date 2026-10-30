export class DefaultOpenAIRootCheckpointLifecycleObserver {
    #recordEvidence = () => { };
    setEvidenceRecorder(recorder) {
        this.#recordEvidence = recorder;
    }
    candidate(outcome) {
        this.#record('candidate', outcome);
    }
    publication(outcome) {
        this.#record('publication', outcome);
    }
    #record(stage, outcome) {
        try {
            this.#recordEvidence(Object.freeze({ type: 'openai_root_checkpoint_lifecycle', version: 1, stage, outcome }));
        }
        catch {
            // Diagnostics must never affect the existing provider or stream path.
        }
    }
}
//# sourceMappingURL=openai-root-checkpoint-lifecycle-observer.js.map