export type ApplyPatchOperation =
  | { type: 'create_file'; path: string; diff: string }
  | { type: 'update_file'; path: string; diff: string }
  | { type: 'delete_file'; path: string };

export type ApplyPatchResult = {
  status: 'completed' | 'failed';
  output: string;
};
