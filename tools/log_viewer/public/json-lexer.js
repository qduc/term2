(function (global) {
    function abort(message) {
        var text = 'Parsing error';
        if (message) text += ': ' + message;
        throw new Error(text);
    }

    var unescapes = {
        '\\': '\\',
        '"': '"',
        '/': '/',
        b: '\b',
        t: '\t',
        n: '\n',
        f: '\f',
        r: '\r',
    };

    function lex(source) {
        var result = [];
        var index = 0;
        var token = lexStep();
        while (token) {
            result.push(token);
            token = lexStep();
        }
        return result;

        function lexStep() {
            var length = source.length;
            var value;
            var begin;
            var position;
            var isSigned;
            var charCode;
            var character;
            while (index < length) {
                character = source[index];
                switch (character) {
                    case '\t':
                    case '\n':
                    case '\r':
                    case ' ':
                        value = source[index];
                        while ('\t\n\r '.indexOf(source[++index]) !== -1) {
                            value += source[index];
                        }
                        return {type: 'whitespace', value: value, raw: value};
                    case '{':
                    case '}':
                    case '[':
                    case ']':
                    case ':':
                    case ',':
                        var punctuator = source[index++];
                        return {
                            type: 'punctuator',
                            value: punctuator,
                            raw: punctuator,
                        };
                    case '"':
                        var stringStartIndex = index;
                        for (value = '', index++; index < length; ) {
                            character = source[index];
                            if (source.charCodeAt(index) < 32) {
                                return abort(
                                    'Unescaped ASCII control characters are not permitted.',
                                );
                            } else if (character === '\\') {
                                character = source[++index];
                                switch (character) {
                                    case '\\':
                                    case '"':
                                    case '/':
                                    case 'b':
                                    case 't':
                                    case 'n':
                                    case 'f':
                                    case 'r':
                                        value += unescapes[character];
                                        index++;
                                        break;
                                    case 'u':
                                        begin = ++index;
                                        for (
                                            position = index + 4;
                                            index < position;
                                            index++
                                        ) {
                                            charCode = source.charCodeAt(index);
                                            if (
                                                !(
                                                    (charCode >= 48 &&
                                                        charCode <= 57) ||
                                                    (charCode >= 97 &&
                                                        charCode <= 102) ||
                                                    (charCode >= 65 &&
                                                        charCode <= 70)
                                                )
                                            ) {
                                                return abort(
                                                    'Invalid Unicode escape sequence.',
                                                );
                                            }
                                        }
                                        value += String.fromCharCode(
                                            '0x' + source.slice(begin, index),
                                        );
                                        break;
                                    default:
                                        return abort(
                                            'Invalid escape sequence.',
                                        );
                                }
                            } else {
                                if (character === '"') {
                                    break;
                                }
                                character = source[index];
                                begin = index;
                                charCode = source.charCodeAt(index);
                                while (
                                    charCode >= 32 &&
                                    charCode !== 92 &&
                                    charCode !== 34
                                ) {
                                    charCode = source.charCodeAt(++index);
                                }
                                value += source.slice(begin, index);
                            }
                        }
                        if (source[index] === '"') {
                            index++;
                            var rawString = source.slice(
                                stringStartIndex,
                                index,
                            );
                            return {
                                type: 'string',
                                value: value,
                                raw: rawString,
                            };
                        }
                        return abort('Unterminated string.');
                    default:
                        begin = index;
                        if (character === '-') {
                            isSigned = true;
                            charCode = source.charCodeAt(++index);
                            character = source[index];
                        }
                        charCode = source.charCodeAt(index);
                        if (charCode >= 48 && charCode <= 57) {
                            if (
                                charCode === 48 &&
                                ((charCode = source.charCodeAt(index + 1)),
                                charCode >= 48 && charCode <= 57)
                            ) {
                                return abort('Illegal octal literal.');
                            }
                            isSigned = false;
                            for (
                                ;
                                index < length &&
                                ((charCode = source.charCodeAt(index)),
                                charCode >= 48 && charCode <= 57);
                                index++
                            );
                            if (source.charCodeAt(index) === 46) {
                                position = ++index;
                                for (
                                    ;
                                    position < length &&
                                    ((charCode = source.charCodeAt(position)),
                                    charCode >= 48 && charCode <= 57);
                                    position++
                                );
                                if (position === index) {
                                    return abort('Illegal trailing decimal.');
                                }
                                index = position;
                            }
                            charCode = source.charCodeAt(index);
                            if (charCode === 101 || charCode === 69) {
                                charCode = source.charCodeAt(++index);
                                if (charCode === 43 || charCode === 45) {
                                    index++;
                                }
                                for (
                                    position = index;
                                    position < length &&
                                    ((charCode = source.charCodeAt(position)),
                                    charCode >= 48 && charCode <= 57);
                                    position++
                                );
                                if (position === index) {
                                    return abort('Illegal empty exponent.');
                                }
                                index = position;
                            }
                            var numberString = source.slice(begin, index);
                            return {
                                type: 'number',
                                value: +numberString,
                                raw: numberString,
                            };
                        }
                        if (isSigned) {
                            return abort(
                                'A negative sign may only precede numbers.',
                            );
                        }
                        var temp = source.slice(index, index + 4);
                        if (temp === 'true') {
                            index += 4;
                            return {type: 'literal', value: true, raw: 'true'};
                        } else if (
                            temp === 'fals' &&
                            source[index + 4] === 'e'
                        ) {
                            index += 5;
                            return {
                                type: 'literal',
                                value: false,
                                raw: 'false',
                            };
                        } else if (temp === 'null') {
                            index += 4;
                            return {type: 'literal', value: null, raw: 'null'};
                        }
                        return abort('Unrecognized token.');
                }
            }
            return false;
        }
    }

    global.jsonLexer = lex;
})(globalThis);
