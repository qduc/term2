# Terminal Escape Codes for ink-testing-library

Use these with `stdin.write(code)` to simulate keyboard input in tests.

## Arrow Keys

| Key | Code | Hex |
|---|---|---|
| Up arrow | `\u001B[A` | `\x1b\x5b\x41` |
| Down arrow | `\u001B[B` | `\x1b\x5b\x42` |
| Right arrow | `\u001B[C` | `\x1b\x5b\x43` |
| Left arrow | `\u001B[D` | `\x1b\x5b\x44` |

## Control Keys

| Key | Code | Notes |
|---|---|---|
| Enter / Return | `\r` | Carriage return |
| Newline | `\n` | Line feed |
| Escape | `\u001B` | Also `\x1b` |
| Backspace | `\u007F` | DEL character |
| Delete | `\u001B[3~` | Forward delete |
| Tab | `\t` | Also `\u0009` |
| Shift+Tab | `\u001B[Z` | Reverse tab |

## Ctrl Combinations

| Key | Code | Notes |
|---|---|---|
| Ctrl+A | `\x01` | Beginning of line |
| Ctrl+B | `\x02` | |
| Ctrl+C | `\x03` | SIGINT / exit |
| Ctrl+D | `\x04` | EOF |
| Ctrl+E | `\x05` | End of line |
| Ctrl+F | `\x06` | |
| Ctrl+G | `\x07` | Bell |
| Ctrl+H | `\x08` | Backspace (alt) |
| Ctrl+K | `\x0b` | Kill to end of line |
| Ctrl+L | `\x0c` | Clear screen |
| Ctrl+N | `\x0e` | Next (history) |
| Ctrl+P | `\x10` | Previous (history) |
| Ctrl+Q | `\x11` | Resume |
| Ctrl+R | `\x12` | Reverse search |
| Ctrl+S | `\x13` | Pause |
| Ctrl+U | `\x15` | Kill line |
| Ctrl+W | `\x17` | Kill word |
| Ctrl+X | `\x18` | |
| Ctrl+Y | `\x19` | Yank |
| Ctrl+Z | `\x1a` | Suspend |

## Page / Navigation Keys

| Key | Code |
|---|---|
| Page Up | `\u001B[5~` |
| Page Down | `\u001B[6~` |
| Home | `\u001B[H` or `\u001BOH` |
| End | `\u001B[F` or `\u001BOF` |
| Insert | `\u001B[2~` |

## Function Keys

| Key | Code |
|---|---|
| F1 | `\u001BOP` |
| F2 | `\u001BOQ` |
| F3 | `\u001BOR` |
| F4 | `\u001BOS` |
| F5 | `\u001B[15~` |
| F6 | `\u001B[17~` |
| F7 | `\u001B[18~` |
| F8 | `\u001B[19~` |
| F9 | `\u001B[20~` |
| F10 | `\u001B[21~` |
| F11 | `\u001B[23~` |
| F12 | `\u001B[24~` |

## Usage Example

```js
const { stdin, lastFrame } = render(<MyMenu />);

// Press down arrow to move selection
stdin.write('\u001B[B');
expect(lastFrame()).toContain('> Item 2');

// Press Enter to select
stdin.write('\r');
expect(lastFrame()).toContain('Selected: Item 2');
```

## How Ink maps these to useInput key object

When you call `stdin.write(code)`, Ink parses it into the `key` object passed
to your `useInput` callback:

```js
useInput((input, key) => {
  key.upArrow      // true when \u001B[A
  key.downArrow    // true when \u001B[B
  key.leftArrow    // true when \u001B[D
  key.rightArrow   // true when \u001B[C
  key.return       // true when \r
  key.escape       // true when \u001B
  key.backspace    // true when \u007F
  key.delete       // true when \u001B[3~
  key.tab          // true when \t
  key.shift        // true when Shift modifier applied
  key.ctrl         // true when Ctrl modifier applied
  key.meta         // true when Meta/Alt modifier applied
  key.pageUp       // true when \u001B[5~
  key.pageDown     // true when \u001B[6~
  input            // the raw character (for regular keys)
});
```
