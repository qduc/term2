import React, {FC} from 'react';
import {Box, Text} from 'ink';
import TextInput from 'ink-text-input';

type Props = {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
};

const InputBox: FC<Props> = ({value, onChange, onSubmit}) => {
  return (
    <Box>
      <Text color="blue">❯ </Text>
      <TextInput value={value} onChange={onChange} onSubmit={onSubmit} />
    </Box>
  );
};

export default InputBox;
